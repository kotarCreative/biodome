# Implementation Plan: Named Targets and Declarative Tasks

Status: partially implemented. Audience: an engineer or LLM implementing this
step-by-step. Complete tasks in order. Run each task's verification before
beginning the next.

The architectural spine is built: RuntimeDriver interface, driver registry,
TargetContext/TaskContext, deployment plan types, builder
(buildTargetPlanEffect / buildTaskPlanEffect), target-scoped output/state paths,
full Docker Compose driver, task runner, non-interactive task wrappers, and
unit tests. All lifecycle commands, including `run <target> <task>` and
`target validate <target>`, are target-scoped. AWS ECS now has an initial
schema-validated driver with rendering, ECR build/push, Fargate start/stop,
status, CloudWatch logs, and unit tests; it remains incomplete for production
use and does not advertise task execution or artifact collection.

## Goal

Make Biodome deploy and operate a sandbox through a user-defined **named target**.
The CLI must not contain cloud-provider commands or reserve target names. `local`,
`aws`, `staging`, `dev`, `review-bot`, and any other valid name are names supplied
by the user's files.

The resulting workflow must be entirely declarative except for selecting a target
or task by name:

```bash
biodome build local
biodome up staging
biodome run staging review-pr
biodome logs staging
biodome down staging
```

In this example, the CLI does not know whether `staging` is Docker Compose, ECS,
Kubernetes, a remote machine, or a custom runtime. The `staging` target file makes
that decision. The `review-pr` task file declares the agent harness, prompt, inputs,
outputs, and cleanup policy.

## Decisions Already Made

- A target is a named deployment profile, stored in `.biodome/targets/<name>.mjs`.
  Its filename, without the extension, is its name.
- A task is a named action profile, stored in `.biodome/tasks/<name>.mjs`.
- Names are opaque labels, not provider identifiers. Do not special-case `aws`,
  `local`, `dev`, `staging`, `production`, or any other target name.
- The only provider-specific identifier is a runtime driver ID in target code, such
  as `"docker-compose"` or `"aws-ecs"`. It is an implementation choice in files,
  never a CLI subcommand or flag.
- Commands are generic. Do not add commands such as `biodome aws`, `biodome ecs`,
  `biodome kubernetes`, or `biodome deploy-aws`.
- A target is required for every lifecycle command. There is no implicit runtime
  default once this feature is complete. `biodome init` creates a `local` target so
  the basic path remains easy.
- Base sandbox features, services, and config are shared by every target. Targets
  only add deployment policy and runtime-driver configuration. They must not mutate
  the base sandbox definition such as languages, services, processes, repositories,
  or agent harnesses.
- Tasks may choose one declared harness and configure its invocation. A task does
  not choose a target; the user explicitly supplies both names with `biodome run
<target> <task>`. This keeps a task reusable across local and cloud targets.
- Generated files and event logs are scoped by target under
  `.biodome-build/targets/<target>/`. Never reuse a global generated compose file
  for two targets.
- Existing no-target commands are intentionally changed rather than kept as hidden
  Docker aliases. This is an unreleased `0.1.0` project and backward compatibility
  would make the target model ambiguous.
- The first cloud implementation is `aws-ecs`. It must be a complete vertical
  slice, but the architecture must allow future drivers without CLI changes.
- Do not add a generic arbitrary provider configuration primitive. Runtime drivers
  own their typed configuration and validation.

## Non-goals

- Multi-cloud support in the first release. Implement Docker Compose and AWS ECS
  only.
- Terraform, Pulumi, CDK, or CloudFormation generation. The ECS driver may use the
  AWS SDK directly; infrastructure prerequisites such as the VPC, subnets, ECR
  repository, and ECS cluster are referenced from target files.
- Automatic cloud account discovery, region inference, or interactive login.
- Scheduled jobs, queues, multi-agent orchestration, and a remote control plane.
- A free-form command prompt passed via the CLI. Named tasks keep operational and
  security decisions in versioned files. Dynamic parameterization can be designed
  after the named-task path works.
- Target inheritance. Users can share ordinary ESM helper functions initially.
  Add explicit target composition only after concrete reuse patterns prove it is
  necessary.

## Terms

- **Base plan:** the existing `Plan` built from `config.json`, `services.mjs`, and
  `features/*.mjs`.
- **Target plan:** the base plan plus exactly one target declaration.
- **Task plan:** an optional task declaration combined with a target plan for a
  `run` operation.
- **Driver:** a trusted Biodome implementation that materializes and operates a
  target plan. Drivers are not loaded from arbitrary project code in this phase.
- **Deployment identity:** a stable, target-scoped ID generated deterministically
  from project and target name. A driver may derive provider resource names from it.

## Desired File Layout

```text
.biodome/
  config.json
  services.mjs
  features/
    node.mjs
    agent.mjs
  targets/
    local.mjs
    staging.mjs
  tasks/
    review-pr.mjs
.biodome-build/
  targets/
    local/
      plan.json
      Dockerfile
      docker-compose.yaml
      state.json
      logs/
    staging/
      plan.json
      Dockerfile
      ecs-task-definition.json
      state.json
      logs/
```

`state.json` is driver-owned runtime state, not user configuration. It may contain
resource IDs, image digests, and timestamps, but never resolved secrets. It must be
written with mode `0600` and its containing generated directories with mode `0700`
where supported.

## Target And Task Examples

### Target: local Docker Compose

```js
// .biodome/targets/local.mjs
export default function local(ctx) {
  ctx.useRuntime("docker-compose");
}
```

### Target: AWS ECS/Fargate

```js
// .biodome/targets/staging.mjs
export default function staging(ctx) {
  ctx.useRuntime("aws-ecs", {
    region: "us-east-1",
    cluster: "biodome-sandboxes",
    repository: "123456789012.dkr.ecr.us-east-1.amazonaws.com/biodome",
    executionRoleArn: { env: "BIODOME_ECS_EXECUTION_ROLE_ARN" },
    taskRoleArn: { env: "BIODOME_ECS_TASK_ROLE_ARN" },
    subnets: ["subnet-0123", "subnet-0456"],
    securityGroups: ["sg-0123"],
    assignPublicIp: false,
    cpu: 1024,
    memoryMiB: 2048,
    ttl: "1h",
  });
}
```

### Task: code review

```js
// .biodome/tasks/review-pr.mjs
export default function reviewPr(ctx) {
  ctx.addTask({
    harness: "codex",
    prompt:
      "Review the current branch. Write prioritized findings with file and line references to /workspace/review.md.",
    artifacts: ["review.md"],
    timeout: "20m",
    cleanup: "always",
  });
}
```

The task uses the harness name from an existing `addCodexHarness`,
`addClaudeHarness`, `addPiHarness`, or `addOpencodeHarness` declaration. The task
schema must not accept an arbitrary executable command in this milestone.

## Architecture

### 1. Extend The Intermediate Representation

File: `src/core/plan.ts`

Add these types. Use schema-backed validation for every input that comes from a
target or task module, following the existing `ProcessSpecSchema` pattern.

```ts
export type RuntimeDriverId = "docker-compose" | "aws-ecs" | (string & {});

export interface RuntimeTarget {
  name: string;
  driver: RuntimeDriverId;
  options: Record<string, unknown>;
}

export interface Task {
  name: string;
  harness: string;
  prompt: string;
  artifacts: string[];
  timeout: string;
  cleanup: "always" | "on-success" | "never";
}

export interface DeploymentPlan {
  target: RuntimeTarget;
  task?: Task;
  deploymentId: string;
}
```

Add `deployment?: DeploymentPlan` to `Plan`. The base plan produced by existing
calls may omit it. A lifecycle operation must use a finalized target plan where it
is present. This avoids forcing unrelated unit tests to invent a target before the
CLI migration is complete.

`Task` names are set by the loader, not by `ctx.addTask`; task files cannot lie
about their identity. Therefore define a task spec with no `name` field:

```ts
export interface TaskSpec {
  harness: string;
  prompt: string;
  artifacts?: string[];
  timeout?: string;
  cleanup?: "always" | "on-success" | "never";
}
```

Validation requirements:

- Target and task names match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`.
- Reject `.` and `..` exactly, even though they match portions of the pattern.
- Reject path separators, whitespace-only names, and names longer than 64
  characters.
- `driver` is a non-empty string.
- Runtime options are structured-clone-safe JSON values only: string, number,
  boolean, null, arrays, and records. Reject functions, symbols, bigint, `undefined`,
  dates, and cyclic records. This allows deterministic serialization to generated
  artifacts.
- Validate driver options in the selected driver's own validator. The generic plan
  schema must only validate that options are JSON values.
- `harness`, `prompt`, and each artifact path are non-empty strings.
- Artifact paths are relative POSIX paths and may not contain `..`, an absolute
  path, or a NUL byte. This prevents task configuration from reading outside the
  workspace when collection is implemented.
- Parse `timeout` and ECS `ttl` as a strict duration using one shared helper. Allow
  only positive values with `s`, `m`, or `h` suffixes. Do not pass shell duration
  strings through to a driver.
- Defaults: `artifacts: []`, `timeout: "20m"`, `cleanup: "never"`.

### 2. Keep Contexts Narrow

Files: `src/core/feature.ts`, `src/core/context.ts`, new
`src/core/target-context.ts`, new `src/core/task-context.ts`

Do not add `useRuntime` and `addTask` to the existing `FeatureContext`. A feature
must not silently select infrastructure, and a target must not silently add
languages or processes.

Create two new interfaces:

```ts
export interface TargetContext {
  useRuntime(driver: RuntimeDriverId, options?: Record<string, unknown>): void;
}

export interface TaskContext {
  addTask(spec: TaskSpec): void;
}
```

Implement `TargetContextImpl` and `TaskContextImpl` as small wrappers around a
private plan-reference object rather than subclasses of `SandboxContext`.

Rules enforced by the implementations:

- `useRuntime` may be called exactly once. A second call throws a `ValidationError`
  that identifies the target file and both driver IDs.
- Target option validation happens immediately after generic JSON-value validation.
- `addTask` may be called exactly once. A task file that declares no task is an
  error, because an empty task file is almost certainly a mistake.
- The loader supplies the target/task name to the context implementation.
- The contexts expose no filesystem, command execution, plan mutation, environment
  resolution, or secret-resolution APIs.

Target and task modules are still trusted local ESM code, just as feature modules
are today. The narrow context prevents accidental architectural coupling; it is not
a security sandbox for malicious configuration code.

### 3. Introduce A Driver Registry

Files: new `src/runtime/driver.ts`, new `src/runtime/registry.ts`, move or adapt
`src/docker/runner.ts` to `src/runtime/docker-compose.ts`

Replace the CLI's `createRuntime(project)` hard-code with a registry lookup based on
`plan.deployment.target.driver`.

Define a driver interface that has separate rendering and operating responsibilities:

```ts
export interface RuntimeDriver<TOptions = unknown> {
  readonly id: string;
  readonly capabilities: Capabilities;

  validateOptions(options: unknown): TOptions;

  render(input: {
    rootDir: string;
    outputDir: string;
    plan: Plan;
    target: RuntimeTarget;
  }): Effect.Effect<RenderedTarget, RuntimeError, never>;

  ensureAvailable(target: RuntimeTarget): Effect.Effect<void, RuntimeError, EventStore>;
  build(input: RuntimeOperationInput): Effect.Effect<BuildResult, RuntimeError, EventStore>;
  start(input: RuntimeOperationInput): Effect.Effect<DeploymentState, RuntimeError, EventStore>;
  stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore>;
  exec(
    input: RuntimeOperationInput & { command: string[] },
  ): Effect.Effect<CommandResult, RuntimeError, EventStore>;
  status(input: RuntimeOperationInput): Effect.Effect<DeploymentStatus, RuntimeError, EventStore>;
  logs(
    input: RuntimeOperationInput & { processName?: string },
  ): Effect.Effect<void, RuntimeError, EventStore>;
  restart(
    input: RuntimeOperationInput & { processName: string },
  ): Effect.Effect<void, RuntimeError, EventStore>;
  collectArtifacts(
    input: RuntimeOperationInput & { paths: string[] },
  ): Effect.Effect<Artifact[], RuntimeError, EventStore>;
}
```

Define explicit serializable result types in the same module:

- `RenderedTarget`: generated file paths and optional image name/tag.
- `BuildResult`: immutable image reference or digest when available.
- `DeploymentState`: driver ID, deployment ID, provider resource IDs, and creation
  time. It must contain no secret values.
- `DeploymentStatus`: a normalized state (`"pending" | "running" | "stopped" |
"failed" | "unknown"`), message, endpoint metadata, and provider-neutral IDs.
- `CommandResult`: exit code, bounded stdout/stderr, and duration. It must use
  defaults compatible with existing MCP command bounds.
- `Artifact`: requested relative path, content type if known, byte size, and local
  generated output path. Do not return unbounded artifact bytes through the driver
  interface.

The initial registry is static and internal:

```ts
const drivers = [dockerComposeDriver, awsEcsDriver];
```

`getRuntimeDriver(id)` must fail with a clear error containing the requested ID and
the available IDs. Do not load arbitrary npm packages or project-relative driver
modules in this phase. A plugin trust and versioning model is a separate design
problem.

Keep `SandboxRuntime` only if it remains useful as an internal compatibility layer.
Prefer replacing it with the driver interface rather than stretching its current
methods: its `project` field and root-directory assumptions cannot represent remote
deployments correctly.

### 4. Target And Task Loading

Files: `src/builder/index.ts`, new `src/builder/target.ts`, new
`src/builder/task.ts`

Add a new public builder entry point:

```ts
buildTargetPlanEffect(rootDir: string, targetName: string, options?: BuildPlanOptions)
```

Its required order is:

1. Validate `targetName` before constructing a filesystem path.
2. Build the existing base plan by reading config, services, and features.
3. Resolve exactly one target module. Prefer `.biodome/targets/<name>.mjs`; if it
   does not exist, fall back to `.js`. If both exist, fail with an ambiguity error.
4. Import the resolved module and require a default function.
5. Invoke it once with `TargetContextImpl`.
6. Require exactly one `useRuntime` call.
7. Look up its driver and validate target options with the driver.
8. Compute `deploymentId` deterministically from a normalized project name and
   target name. Use a slug plus a short SHA-256 digest to prevent collisions after
   provider-specific length truncation. Never use a random UUID for resource names.
9. Attach `deployment` to the plan.
10. Run existing `validatePlan` plus target-specific validation.

Add:

```ts
buildTaskPlanEffect(rootDir: string, targetName: string, taskName: string, options?: BuildPlanOptions)
```

It calls `buildTargetPlanEffect`, then validates/resolves/imports exactly one task
module by the same `.mjs`-then-`.js` rules, invokes it with `TaskContextImpl`, and
attaches the named task to `plan.deployment`.

After a task is attached, validate that its `harness` exists in exactly one of
`agentHarnesses`, `piHarnesses`, `codexHarnesses`, or `claudeHarnesses`. Fail before
building/deploying rather than discovering a typo in a running sandbox.

Do not execute target/task modules in `biodome config validate` until that command
accepts a target explicitly. Add `biodome target validate <target>` in the CLI work
below. This preserves the current config-only validation behavior.

### 5. Scope Generated Output And Runtime State

Files: `src/cli/index.ts`, `src/core/events.ts`, driver renderers

Replace the global build directory assumptions with helpers:

```ts
buildRoot(rootDir) => join(rootDir, ".biodome-build")
targetBuildDir(rootDir, targetName) => join(buildRoot(rootDir), "targets", targetName)
targetStatePath(rootDir, targetName) => join(targetBuildDir(...), "state.json")
```

Every generated artifact for a targeted lifecycle command must be written below the
target directory. This includes Dockerfile, compose file, supervisord config,
healthcheck scripts, repo scripts, harness files, MCP `plan.json`, copied MCP server,
logs, cloud task definitions, and state.

`writeGeneratedFiles` becomes driver rendering:

- Move Docker-specific generation to the Docker Compose driver's `render` method.
- Preserve existing generator functions initially; change only their output paths.
- The AWS driver renders an ECS task-definition JSON and any task wrapper scripts.
- Keep `.dockerignore` and the `.gitignore` `.biodome-build/` entry at the project
  root because they apply to all targets.

Event paths must include target names. Extend every lifecycle event payload with
`target` and `driver`. Existing event schemas and tests need updates. This enables
operators to distinguish a local run from a staging run without parsing paths.

State handling requirements:

- Read state before `start`, `stop`, `status`, `logs`, `exec`, `restart`, and
  artifact collection.
- Include `schemaVersion`, target name, driver ID, deployment ID, and a creation
  timestamp in state. Validate all four before acting on it.
- Refuse to use state belonging to a different target, project-derived deployment
  ID, or driver.
- Write atomically: write a temporary file in the same directory, `chmod 0600`,
  then rename it.
- A failed `start` must either remove new state or write an explicit `failed` state
  with enough resource IDs for a later `down` to clean up.

### 6. Generic CLI Migration

File: `src/cli/index.ts`

Do not add provider-specific commands. Change lifecycle commands to take a target:

```text
biodome build <target>
biodome up <target> [--build] [--wait]
biodome down <target>
biodome exec <target> <command...>
biodome logs <target> [process]
biodome ps <target>
biodome status <target>
biodome restart <target> [process]
biodome run <target> <task>
biodome target validate <target>
```

Command behavior:

- `build`: build target plan, render through the driver, ensure availability, run
  `build.pre` hooks, driver build, then `build.post` hooks.
- `up`: build target plan, render through the driver, ensure availability, run
  `start.pre`, driver start, persist returned state, then `start.post`.
- `down`: build target plan and read matching state, run `stop.pre`, driver stop,
  then `stop.post`. Delete state only after a successful stop.
- `exec`, `logs`, `ps`, `status`, and `restart`: build target plan, load matching
  state, then invoke the named generic driver method.
- `target validate`: build the target plan in dry-run mode, validate it, render to
  no real output directory, and print the chosen driver, deployment ID, and
  capabilities. It must not call a provider API or build an image.
- `run`: build the target/task plan, render and start the target if needed,
  execute the task using the selected harness, collect artifacts, apply cleanup,
  and emit a final task result event. Detailed behavior is in Task 9 below.

`biodome info` and `biodome generate agents.md` remain base-plan commands for this
milestone. Add optional target-aware views later only if consumers need target
endpoints. They must not silently default to `local`.

Update Commander command syntax carefully: `<target>` must be the first positional
argument, so `exec` becomes `.command("exec <target> <command...>")`. Preserve
`.allowUnknownOption()` for the command portion only.

### 7. Docker Compose Driver Migration

Files: `src/docker/generator.ts`, `src/docker/runner.ts`, new or renamed files in
`src/runtime/`, tests under `src/tests/docker/`

Make Docker Compose the reference driver before implementing AWS. Its behavior must
remain equivalent to the current CLI after target paths are accounted for.

Required changes:

1. Move the Docker runtime construction out of `src/cli/index.ts` and expose a
   `dockerComposeDriver` with ID `"docker-compose"`.
2. Replace the constant global compose path with a path supplied by
   `RuntimeOperationInput.outputDir`.
3. Derive Compose project name from `deploymentId`, not raw `plan.project`, so two
   targets for one project can run at the same time without container-name or port
   collision. Preserve Docker-compatible name constraints in the derivation.
4. Have `render` produce the same Dockerfile, Compose, supervisord, health-check,
   repository, harness, MCP, and plan artifacts currently produced by
   `writeGeneratedFiles`.
5. Write a Docker driver state file after `start` containing the Compose project
   name and service identity. Do not infer it from a raw project name later.
6. `collectArtifacts` uses `docker cp` or a tar stream from the dev container into
   `<targetBuildDir>/artifacts/`. Before copying, validate every requested path and
   ensure it resolves below `/workspace` in the container.
7. Keep existing `biodome logs` tail behavior for Docker. Remote drivers may choose
   different implementations but must honor the same generic command.

Before starting the ECS work, add integration coverage that creates two differently
named local targets for one fixture and proves their generated Compose project names
and output directories differ. Do not start both if their feature plan exposes the
same host ports; plan validation should report that conflict clearly.

### 8. AWS ECS/Fargate Driver

Files: new `src/runtime/aws-ecs.ts`, new `src/runtime/aws-ecs-schema.ts`, new
`src/tests/runtime/aws-ecs.test.ts`, `package.json`, lockfile

Add the smallest AWS SDK dependency set needed for ECR and ECS. Do not add a broad
AWS client bundle. Use AWS's standard credential provider chain; target files only
declare AWS resource references and secret references, not AWS access keys.

Define and validate this initial target option shape:

```ts
interface AwsEcsOptions {
  region: string;
  cluster: string;
  repository: string;
  executionRoleArn: SecretValue;
  taskRoleArn?: SecretValue;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp?: boolean;
  cpu?: number;
  memoryMiB?: number;
  ttl?: string;
}
```

Rules:

- `region`, `cluster`, `repository`, every subnet, and every security group are
  required non-empty strings.
- Require at least one subnet and security group.
- `executionRoleArn` and `taskRoleArn` must be environment references, not literal
  strings. The role ARNs are sensitive deployment metadata and must not be written
  as resolved values.
- Defaults: `assignPublicIp: false`, `cpu: 1024`, `memoryMiB: 2048`, `ttl: "1h"`.
- Validate CPU/memory pairs against the Fargate compatibility table in one tested
  helper. Start with only documented valid pairs; do not let ECS return an opaque
  API error.

Initial scope is one ECS task definition containing the dev container. Do not try
to translate arbitrary Docker Compose services to ECS in this milestone. Target
validation must reject a plan containing `runtime.services` when driver is
`aws-ecs`, with an explicit message: backing service containers are supported by
`docker-compose` but not yet by `aws-ecs`; use managed services or proxy MCP
providers instead. This is preferable to a partial or silently incorrect Compose
translation.

Driver algorithm:

1. `render` writes a deterministic ECS task-definition document to the target
   output directory. It uses the same generated Dockerfile and harness files as
   Docker, but it does not write Compose.
2. `build` invokes Docker Buildx to build the generated Dockerfile for
   `linux/amd64`, tags it with the deterministic deployment ID plus a content hash,
   authenticates to the declared ECR repository, and pushes it. Store and return
   the image digest, not only a mutable tag.
3. `start` resolves only the required environment references immediately before
   AWS API calls. Register the task definition with the pushed image digest, run a
   Fargate task with `awsvpc` configuration, and wait only until the task is in
   `RUNNING` or `STOPPED`/failed. Persist task ARN, task-definition ARN, image
   digest, cluster, region, and creation time in state.
4. Do not put application, LLM, MCP, repo, or volume secret values directly in the
   ECS task definition. The first cloud vertical slice supports only environment
   references that are available to the build/deploy host. Use ECS task `secrets`
   integration only in a later dedicated secrets-provider design.
5. `status` calls `DescribeTasks` using task ARN from validated state and maps ECS
   `lastStatus` and `stopCode` to `DeploymentStatus`.
6. `logs` uses the CloudWatch log group/stream created by the task definition.
   Configure an explicit log group and stream prefix derived from deployment ID;
   never guess a stream by enumerating every log stream in an account.
7. `stop` calls `StopTask`, waits for `STOPPED` with a bounded timeout, then
   deregisters the generated task definition only when no active task references
   it. It must be idempotent: a missing/already stopped task is success.
8. `exec` uses ECS ExecuteCommand only if the target opts in with a future explicit
   option. For this milestone, advertise no `exec.command` capability and fail the
   generic `biodome exec <ecs-target>` command before any AWS call with an
   actionable capability error.
9. `restart` is implemented as stop then start, preserving the same image digest
   from state unless `--build` was explicitly requested during a later `up`.
10. `collectArtifacts` is not supported for the first ECS implementation. Do not
    claim the capability. `biodome run` must reject artifact-bearing tasks on an
    ECS target until Task 10 adds an artifact store. A task with `artifacts: []`
    may still run and returns its harness exit result through logs/events.

The Fargate task must run non-root, preserve the existing container hardening, have
no public IP by default, and have only outbound network access required by the
target's subnet/security-group policy. The driver must not set `privileged`, host
networking, or host mounts.

### 9. Named Task Execution

Files: new `src/core/task-runner.ts`, CLI, Docker driver, tests

Implement `biodome run <target> <task>` only after the Docker target driver is
complete. The task runner is target-neutral and depends on driver capabilities.

Algorithm:

1. Build the task plan with `buildTaskPlanEffect`.
2. Render the target and ensure the driver is available.
3. Read validated state. If absent or not running, build, start, and write state.
   If present and running, reuse it. Do not rebuild an existing deployment unless
   a future explicit `--build` option is added.
4. Resolve the selected harness into a command. Create one pure function per
   harness family. It must use generated wrapper paths rather than reconstructing
   provider-specific CLI flags at call time.
5. Invoke the command through `driver.exec` only when the driver has
   `exec.command`. Enforce the validated task timeout and bounded output.
6. If `task.artifacts` is non-empty, require `artifact.collect` capability and
   call `driver.collectArtifacts` only after a successful command. Record returned
   artifact metadata in the final event and print the generated local paths.
7. Emit `task.started`, `task.completed`, or `task.failed` with target, driver,
   task name, harness name, duration, exit code, and artifact metadata. Never log
   prompt contents, command arguments, model credentials, tool payloads, or
   artifact bodies by default.
8. Apply cleanup in a `finally`-style path:
   - `always`: stop and remove state whether task succeeds or fails.
   - `on-success`: stop/remove state only when task succeeds.
   - `never`: leave the deployment running and retain state.
     If cleanup fails, preserve the primary task error and attach cleanup failure as
     secondary context.

For initial harness commands:

- Pi: invoke its generated Pi wrapper with `-p <prompt>`.
- Claude: invoke its generated Claude wrapper with `-p <prompt>`.
- Codex: use a generated non-interactive wrapper script, not an undocumented
  direct `exec-server` protocol call.
- OpenCode: invoke a generated non-interactive wrapper (`opencode run "$<prompt>"`) that
  resolves `${VAR}` refs in its config from the container env, mirroring the serve start
  script. `run` supports OpenCode tasks the same way it supports Pi/Claude/Codex tasks.

Add a dedicated `"artifact.collect"` capability to `src/core/capabilities.ts`.
Docker advertises it; ECS does not in the initial cloud slice.

### 10. ECS Artifact Collection Follow-up

Do not implement this in the first named-target pull request. Create it only after
the Docker task path is verified.

The follow-up design must add an explicit task or target output store declaration,
for example an S3 prefix represented by environment references and IAM task-role
permissions. The agent writes artifacts to a declared output path; the driver
downloads only those declared objects after task completion. Do not enable remote
shell access or broad S3 listing merely to fetch artifacts.

## Implementation Tasks

### Task 1: Target and Task Schemas

Files: `src/core/plan.ts`, new duration/path helper if needed,
`src/tests/core/plan.test.ts` (new)

1. Add deployment and task types, input schemas, name validation, artifact-path
   validation, duration parsing, and JSON-value validation described above.
2. Add `deployment?: DeploymentPlan` to `Plan` and `PlanSchema`.
3. Add tests for valid names, invalid traversal/whitespace/separator names, valid
   JSON options, invalid non-JSON options, durations, artifact paths, and defaults.

Verify:

```bash
npm run typecheck
npm run test:run
```

### Task 2: Narrow Target and Task Contexts

Files: `src/core/feature.ts`, new context files, tests

1. Add exported `TargetContext`, `TaskContext`, and `TaskSpec` types.
2. Implement the narrow context classes.
3. Add tests that target modules cannot declare two runtimes and task modules
   cannot declare zero or two tasks.
4. Confirm `FeatureContext` has not gained target/task methods.

Verify:

```bash
npm run typecheck
npm run test:run
```

### Task 3: Driver Registry and Target Builders

Files: new runtime registry modules, `src/builder/index.ts`, new builder tests

1. Define serializable driver input/output types and the registry API.
2. Register a temporary test driver in tests only; production registry may initially
   contain only an unimplemented Docker placeholder.
3. Implement safe target and task module resolution with `.mjs` precedence,
   `.js` fallback, ambiguity detection, default-export validation, and name safety.
4. Implement `buildTargetPlanEffect` and `buildTaskPlanEffect`.
5. Test no target, both extensions, bad export, missing runtime, unknown driver,
   bad driver options, missing task, bad task export, and unknown harness.

Verify:

```bash
npm run typecheck
npm run test:run
```

### Task 4: Target-Scoped Files, State, and Events

Files: CLI helpers, events, generated file tests

1. Add target build-directory and atomic state helpers.
2. Add `target` and `driver` to relevant lifecycle event schemas and emitters.
3. Update event tests and assert generated outputs cannot overlap between targets.
4. Update init scaffolding to create `.biodome/targets/local.mjs`.
5. Update `.gitignore` behavior only if necessary; it should continue ignoring the
   one top-level `.biodome-build/` directory.

Verify:

```bash
npm run check
```

### Task 5: Migrate Docker Compose Into the Driver Model

Files: Docker generator/runner, CLI, Docker tests, integration tests

1. Implement the full `docker-compose` driver using current behavior.
2. Update CLI lifecycle commands to require target names and use registry lookup.
3. Add `biodome target validate <target>`.
4. Update every command/documentation test that assumes the global generated path.
5. Add integration coverage for `biodome build local`, `up local`, `status local`,
   and `down local` using the scaffolded local target.

Verify:

```bash
npm run check
npm run test:integration
```

### Task 6: Implement and Test Named Tasks Locally

Files: task runner, CLI, Docker driver, unit/integration tests

1. Implement task command construction for Pi, Claude, and Codex wrappers.
2. Add the generic `run <target> <task>` command.
3. Add artifact collection to Docker.
4. Test task validation, harness resolution, cleanup modes, failed task cleanup,
   event redaction, and artifact path validation.
5. Add a Docker integration fixture whose task writes a known small artifact without
   requiring a real LLM credential. Use a harmless mock harness wrapper in the
   fixture; do not invoke a real model in CI.

Verify:

```bash
npm run check
npm run test:integration
```

### Task 7: Add AWS ECS Driver

Files: AWS driver/schema/tests, package files, docs

1. Add minimal AWS SDK dependencies and confirm the production audit has no new
   high/critical findings.
2. Implement schema validation and pure rendering first.
3. Unit-test ECR image tagging, task-definition rendering, Fargate CPU/memory
   validation, no resolved secrets in artifacts/state/events, state mapping, status
   mapping, idempotent stop, and rejected unsupported features.
4. Implement API calls behind injected AWS clients so unit tests never contact AWS.
5. Add a manually run, opt-in integration test gated by explicit AWS environment
   variables. It must create resources with a unique deployment ID and always stop
   the task in a cleanup block.
6. Do not make cloud credentials a requirement for the normal CI suite.

Verify:

```bash
npm run check
npm audit --omit=dev
```

### Task 8: Documentation and Migration

Files: `README.md`, `docs/index.md`, `docs/file-layout.md`, `docs/primitives.md`,
`docs/api.md`, `docs/processes.md`, `docs/ROADMAP.md`

1. Document targets, tasks, generic command syntax, generated target directories,
   state handling, and the local target scaffold.
2. Document ECS prerequisites and explicit limitations: no Compose backing services,
   no remote exec, no artifacts in the first slice.
3. Update every quick-start command to use `local`.
4. Add a migration section explaining that lifecycle commands now require a named
   target and how to add `.biodome/targets/local.mjs` to existing projects.
5. Move this plan's completed work into the roadmap only after the implementation
   is actually merged.

Verify:

```bash
rg -n "biodome (build|up|down|exec|logs|ps|status|restart)(\\s|$)" README.md docs
```

Manually inspect every match: it must either show the required `<target>` argument
or intentionally describe the pre-target migration.

## Acceptance Criteria

- [ ] Users define arbitrary target names only through files in
      `.biodome/targets/`; the CLI has no provider-specific commands or reserved
      provider target names.
- [ ] All lifecycle commands resolve a target by name and use a driver registry,
      not `new DockerRuntime(...)` in the CLI.
- [ ] `biodome init` creates a functional `local` target and `biodome up local`
      retains the current local Docker workflow.
- [ ] Target configuration cannot mutate the base sandbox plan through its public
      context API.
- [ ] Generated artifacts, state, and event logs are target-scoped and cannot
      collide for two targets in the same repository.
- [ ] Named tasks are file-defined, validate their referenced harness before
      deployment, execute through a generic command, and honor cleanup policy.
- [ ] Docker supports named-task execution and safe artifact collection.
- [ ] `aws-ecs` is selectable only from a target file, validates its configuration,
      builds/pushes an immutable image, starts/stops/statuses a Fargate task, and
      never writes resolved secrets to generated artifacts, state, or default logs.
- [ ] Unsupported ECS features fail before cloud API calls with an actionable
      capability or validation error.
- [ ] Normal CI remains local-only and passes `npm run check`; AWS integration is
      explicitly opt-in.

## Final Verification

Run after all implementation tasks:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run test:integration
npm audit --omit=dev
```

Then manually validate a fixture with two targets:

```bash
biodome target validate local
biodome build local
biodome up local
biodome run local review-pr
biodome status local
biodome down local
```

Inspect `.biodome-build/targets/local/` and confirm it contains no resolved secret,
and inspect the event log to confirm every lifecycle/task event carries the selected
target and driver.

## Remaining Work

- **AWS ECS hardening and proof**: The initial driver can render, build/push,
  start/stop, inspect status, and read logs, but still needs the remaining
  production behavior from Task 7: ECS service-plan rejection, start-state
  waiting and failure handling, immutable image digest persistence, TTL
  handling, and an opt-in AWS integration test. It intentionally advertises no
  `exec.command` or `artifact.collect` capability.
- **CLI integration coverage**: Unit tests now cover `task-runner.ts`,
  `target-context.ts`, and `task-context.ts`; local Docker integration covers
  build/start/status/artifact/cleanup operations. Add an end-to-end CLI fixture
  for `biodome run local review-pr`, plus dedicated driver tests where the
  existing coverage is insufficient.
- **Event target-scoping**: Events still write to `.biodome-build/logs/` — need
  target-scoped paths with `target`/`driver` in payload.
