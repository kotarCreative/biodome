# Implementation Plan: Local Named Task Execution

Status: proposed. Audience: an engineer or smaller implementation model.

## Goal

Make the following workflow reliable for the Docker Compose target:

```bash
biodome run local review-pr
```

The command must build and start the target only when necessary, execute a named
agent task through its declared harness, collect declared workspace artifacts, and
apply the task cleanup policy. The first complete use case is a code review task
that writes `/workspace/review.md` and makes it available locally under the target
build directory.

This plan deliberately does **not** implement AWS ECS. ECS must consume the same
driver/task contract after the local path is proven by integration tests.

## Current State And Constraints

- Target/task plan loading and the runtime registry already exist.
- `docker-compose` is the only complete driver; `aws-ecs` is a stub.
- The CLI still has legacy un-targeted lifecycle commands. Do not keep them as
  hidden aliases: targeted commands are the intended public interface.
- Generated target files are host files under
  `.biodome-build/targets/<target>/` and are available in the container at
  `/workspace/.biodome-build/`. Harness task commands therefore use container
  paths, never host paths.
- Task prompts, command arguments, model credentials, agent output, and artifact
  contents are sensitive. Do not put them in normal lifecycle events or info logs.
- The existing `src/core/task-runner.ts` is incomplete and is not called by the
  CLI. Replace or reshape it as part of this work; do not duplicate task logic in
  the CLI.

## Scope Decisions

- Support task execution only on drivers advertising `exec.command`.
- Support artifact collection only on drivers advertising `artifact.collect`.
- Docker is the sole driver advertising `artifact.collect` in this milestone.
- Support Pi, Claude, and Codex tasks. OpenCode tasks fail before starting a
  deployment with an actionable unsupported-harness error.
- A task always runs from `/workspace`.
- Do not add arbitrary task shell commands. A task continues to select one
  declared harness by name.
- Do not resolve or persist secret values. Harness wrappers receive their existing
  environment references only at container runtime.

## Required User-Facing Behavior

Given this task:

```js
export default function reviewPr(ctx) {
  ctx.addTask({
    harness: "reviewer",
    prompt: "Review the current branch and write findings to review.md.",
    artifacts: ["review.md"],
    timeout: "20m",
    cleanup: "always",
  });
}
```

`biodome run local review-pr` must:

1. Build the target/task plan and validate the selected driver and harness before
   starting Docker.
2. Render the target and verify Docker is available.
3. Read validated target state. If the state is absent or the driver reports it is
   not running, build/start the target and atomically write new state. If it is
   running, reuse it without rebuilding.
4. Run the generated non-interactive harness wrapper inside the `dev` container.
5. Fail the task when the harness exits non-zero or exceeds its validated timeout.
6. On successful execution, copy only declared artifacts from `/workspace` into
   `.biodome-build/targets/local/artifacts/`.
7. Apply cleanup: `always` stops/removes state after success or failure;
   `on-success` only after exit code zero; `never` retains the deployment/state.
8. Print artifact local paths and a concise result. Do not print the task prompt
   or complete agent command.

## Implementation Tasks

Complete tasks in order. Run the listed verification before moving on.

### Task 1: Finish The Driver Contract

Files:

- `src/core/capabilities.ts`
- `src/runtime/driver.ts`
- `src/runtime/docker-compose.ts`
- new `src/tests/runtime/docker-compose.test.ts` if focused driver tests do not fit
  existing Docker test files

1. Add the `artifact.collect` capability.
2. Add `collectArtifacts(input)` to `RuntimeDriver`. Its input is
   `RuntimeOperationInput` plus `paths: string[]`; it returns artifact metadata
   only: requested relative path, byte size, and local generated path. Do not
   return artifact bytes.
3. Make status return the normalized state union already described in the named
   targets design (`pending`, `running`, `stopped`, `failed`, `unknown`) rather
   than an unconstrained `string`.
4. Add the capability to Docker and implement `collectArtifacts` with `docker cp`
   from `<deploymentId>-dev:/workspace/<relative path>` into
   `<outputDir>/artifacts/<relative path>`.
5. Preserve artifact subdirectories. Create output parent directories as needed.
   Reject any path that is not already a valid task artifact path; never pass an
   absolute or traversal path to Docker.
6. Calculate copied file size after copying. If Docker reports a missing artifact,
   return a task/runtime error naming only the declared relative path.
7. Do not add `collectArtifacts` to the ECS stub yet. It must advertise no such
   capability.

Verify:

```bash
npm run typecheck
npm run test:run
```

### Task 2: Generate Explicit Non-Interactive Task Wrappers

Files:

- `src/docker/generator.ts`
- `src/tests/docker/generator.test.ts`

1. Add one generated executable task wrapper per supported Pi, Claude, and Codex
   harness. Place wrappers with that harness's generated home directory.
2. The wrapper must configure its isolated home/config, preserve the existing
   telemetry setup, and invoke the provider's documented non-interactive command
   with the prompt passed as an argument.
3. Do not use Codex `exec-server` for a task. Generate a distinct Codex
   non-interactive wrapper; its server-start wrapper remains for daemon use.
4. Return a command builder result using fixed container paths such as
   `/workspace/.biodome-build/claude-homes/<name>/task`, never `existsSync` or a
   host output path.
5. Put this pure command-building function in `src/core/task-runner.ts` (export it
   for unit tests) or a small adjacent module. It must reject OpenCode before any
   runtime action.
6. Add generator tests asserting each wrapper has the correct absolute container
   home, is executable, and does not contain a resolved API key.

Verify:

```bash
npm run check
```

### Task 3: Make Target State Safe And Usable

Files:

- `src/runtime/state.ts`
- `src/runtime/output.ts`
- `src/tests/runtime/state.test.ts` (new)

1. Make `readState` validate `target`, `driver`, and `deploymentId`, not only the
   deployment ID. Add expected driver as an argument.
2. Change `removeState` to unlink the state file. Do not rename it to `.bak`, which
   leaves stale state and violates cleanup semantics.
3. Ensure the target output directory is mode `0700` where supported and state is
   written atomically with mode `0600`.
4. Add a helper for the artifact root only if it avoids duplicating the exact path
   in the Docker driver and task runner. Do not add a general filesystem utility
   layer.
5. Test state rejection for a mismatched target, driver, deployment ID, invalid
   schema version, and malformed JSON; test successful state removal.

Verify:

```bash
npm run typecheck
npm run test:run
```

### Task 4: Implement One Target-Neutral Task Runner

Files:

- `src/core/task-runner.ts`
- `src/core/events.ts`
- new `src/tests/core/task-runner.test.ts`

1. Refactor `executeTask` to own the complete algorithm below. It receives the
   root directory, finalized task plan, selected driver, and any required event
   service. The CLI must not reproduce any part of this algorithm.
2. Before each optional operation, check the advertised driver capability. Return
   a clear error before calling the driver when a capability is absent.
3. Render and call `ensureAvailable`. Read matching state. Call `driver.status`
   when state exists; reuse only a `running` deployment. For missing, invalid, or
   non-running state, build/start and write new state.
4. Run the pure harness command through `driver.exec`. Enforce the parsed task
   timeout in the driver process invocation, not with an unbounded outer promise.
   Bound captured stdout/stderr using the same policy as MCP command execution.
5. Treat a non-zero command exit code as task failure. Collect artifacts only after
   exit code zero.
6. For non-empty artifacts, require `artifact.collect`; invoke collection once and
   return metadata/local paths.
7. Emit `task.started`, `task.completed`, and `task.failed` metadata events. Events
   include target, driver, task name, harness, duration, exit code, and artifact
   metadata. They must exclude prompt text, command arguments, output, credentials,
   and artifact bodies.
8. Apply cleanup in a finalizer-style path. Preserve the primary task failure if
   cleanup also fails; attach the cleanup failure as secondary context. Never stop
   a reused deployment for `on-success` after a failing task.
9. Unit-test with a fake `RuntimeDriver`; do not require Docker for these cases.
   Cover fresh start, reuse, non-zero exit, timeout propagation, each cleanup mode,
   unsupported capability, collection only after success, event redaction, and
   cleanup failure preserving the primary error.

Verify:

```bash
npm run check
```

### Task 5: Replace Legacy Lifecycle CLI Paths

Files:

- `src/cli/index.ts`
- `src/cli/helpers.ts`
- CLI helper tests

1. Remove the legacy CLI-owned Docker generation/runtime path (`writeGeneratedFiles`,
   `createRuntime`, and imports used solely by it). Keep base-plan `info`,
   `generate agents.md`, and `config validate` unchanged.
2. Convert lifecycle syntax to:

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
```

3. Each lifecycle command must load `buildTargetPlanEffect`, get the driver from
   the registry, use `targetBuildDir`, validate/read state where required, and
   enforce the relevant driver capability before invoking it.
4. `build` renders, checks availability, and builds; `up` renders, checks
   availability, builds only with `--build`, starts, and writes state; `down`
   validates state, stops, then removes state only after a successful stop.
5. Make `run` call only `executeTask`. Remove its current unconditional start,
   inline harness command building, and inline cleanup.
6. Do not log the generated harness command. Print target/task identity, outcome,
   and artifact paths only.
7. Target-scope event log paths and include target/driver in lifecycle events while
   retaining a base-plan event path only for base-plan commands.
8. Update Commander argument ordering carefully: `exec` is
   `exec <target> <command...>` and still accepts command flags.

Verify:

```bash
npm run check
```

### Task 6: Prove The Real Local Workflow

Files:

- `src/tests/integration/` fixtures and tests
- `README.md`
- `docs/index.md`
- `docs/file-layout.md`
- `docs/processes.md`
- `docs/ROADMAP.md`

1. Add an integration fixture with a local target, a supported mock harness, and a
   task that writes a small known `review.md` in `/workspace`. It must not call an
   LLM provider or need credentials.
2. Run `biodome run local review-pr` against the fixture and assert the copied
   artifact exists beneath `targets/local/artifacts/review.md`, has expected
   contents, and Docker is stopped for `cleanup: "always"`.
3. Add integration coverage for targeted `build local`, `up local`, `status local`,
   and `down local`. Add a two-target render test proving separate output
   directories and Compose project identities.
4. Document the target/task layout, the `run` command, artifact location, cleanup
   policies, and the limitation that ECS task execution/artifacts are not yet
   available.
5. Update the roadmap: this work is complete only after every test above passes.
   ECS remains the next cloud milestone.

Verify:

```bash
npm run check
npm run build
npm run test:integration
```

## Acceptance Criteria

- `biodome run local review-pr` works against a Docker target without an LLM call
  in CI.
- A running target is reused; a stopped or missing target starts once and writes
  validated state.
- Declared artifacts are copied only from `/workspace` to the selected target's
  artifact directory.
- Cleanup behavior matches `always`, `on-success`, and `never` for success and
  failure.
- Prompts, commands, credentials, output, and artifact bodies are absent from
  default CLI lifecycle events and logs.
- All lifecycle commands require a target and no longer instantiate the legacy
  Docker runtime directly.
- ECS remains a stub and cannot claim task execution or artifact capabilities.

## Final Verification

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run test:integration
npm audit --omit=dev
```
