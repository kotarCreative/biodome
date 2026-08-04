# Agent task orchestration

Biodome separates the thing a task needs from the system that runs it.

```text
.biodome services, apps, features, task, target
                 │
                 ▼
        portable ExecutionPlan
                 │
     ┌───────────┼────────────┐
     ▼           ▼            ▼
Docker Compose  Docker Sandboxes  AWS ECS
```

The portable plan describes the project, task prompt, selected harness,
services, processes, workspace policy, network requirement, resource request,
artifacts, and required provider capabilities. A provider renders that intent
into its native resources. Provider-specific options belong in a target, not in
the task.

## Targets select providers

Targets are JavaScript modules in `.biodome/targets/`. The target name is used
by every lifecycle command.

```javascript
// .biodome/targets/local.mjs
export default function local(ctx) {
  ctx.useRuntime("docker-compose");
}
```

Docker Sandboxes is a local microVM-backed provider. It requires Docker
Sandboxes and an authenticated `sbx` CLI on the machine running Biodome.

```javascript
// .biodome/targets/secure-local.mjs
export default function secureLocal(ctx) {
  ctx.useRuntime("docker-sandbox", {
    agent: "codex", // optional; inferred from Codex/Claude/OpenCode harnesses
    clone: true, // use clone mode instead of a writable bind mount
    template: "ghcr.io/acme/project-sandbox:latest",
    kits: ["./.biodome/sandbox-kit"],
    cpus: 4,
    memory: "8g",
    cloneWorkspacePath: "/workspace",
  });
}
```

`template` and `kits` are prebuilt Docker Sandbox inputs. Biodome renders the
project task files but deliberately does not build an `sbx` template from its
generated Dockerfile. Treat the target options as provider-specific: a Compose
or ECS target will use different options while executing the same task intent.

Supported Docker Sandbox options are `agent`, `template`, `kits`, `clone`,
`cpus`, `memory`, and `cloneWorkspacePath`.

## Tasks define portable intent

Tasks live in `.biodome/tasks/` and export one `addTask` call. The harness is
defined by a feature (`addCodexHarness`, `addClaudeHarness`, `addPiHarness`, or
`addOpencodeHarness`). Agent adapters resolve the selected harness to the
command that runs inside a provider-prepared workspace; providers do not need
to know individual agent command syntax.

```javascript
// .biodome/tasks/review-pr.mjs
export default function reviewPr(ctx) {
  ctx.addTask({
    harness: "reviewer",
    prompt: "Review the current change and write a concise report to review.md.",
    artifacts: ["review.md", "test-results/**"],
    timeout: "30m",
    cleanup: "always",

    requiredServices: ["postgres", "redis"],
    requiredProcesses: ["api"],
    capabilities: [
      { capability: "network.policy", level: "preferred", reason: "restrict egress" },
      { capability: "exec.pty", level: "preferred", reason: "interactive debugging" },
    ],
    resources: { cpu: 4, memoryMiB: 8192, diskMiB: 20480 },
    network: { mode: "egress", allow: ["api.github.com:443", "api.openai.com:443"] },
    workspace: { strategy: "clone", repository: "https://github.com/acme/app.git", ref: "main" },
    validationCommands: [
      ["npm", "test"],
      ["npm", "run", "lint"],
    ],
  });
}
```

The task executor runs `validationCommands` after the agent succeeds and before
collecting artifacts. Task `network` and `resources` are declared intent and
are preflighted where the selected provider advertises relevant support. Do not
rely on a declaration alone as a security boundary.

`requiredServices` and `requiredProcesses` default to all declared services and
daemon processes when omitted. A task always requires command execution; tasks
with artifacts also require artifact collection. These implicit requirements
are included in compatibility checks.

## Plan before run

Use `plan` before spending local or cloud resources. It compiles the named task
and target into the provider-neutral execution plan, then reports required and
preferred capability gaps.

```bash
biodome plan local review-pr
biodome plan secure-local review-pr --json
biodome run secure-local review-pr
```

`--json` prints both the portable execution plan and the compatibility report,
which is useful for CI policy checks. A required missing capability prevents a
run; a preferred one is reported as a warning.

## Runs, events, and artifacts

Every `biodome run <target> <task>` creates a durable run record under:

```text
.biodome-build/targets/<target>/logs/runs/<run-id>.json
```

The record includes the provider, target, task, plan digest, timestamps,
attempt result, collected artifacts, and lifecycle state. States progress
through `planned`, `preparing`, `ready`, `executing`, optional `collecting`, a
terminal result, optional `cleaning-up`, and `complete`.

Structured event logs remain separate and are stored alongside the target logs.
Use `biodome events` or `biodome events --run <run-id>` to inspect them. Declared
artifacts are collected under the target build directory and recorded with their
local path and size.

Before changing a target, a run validates the target, task, harness command, and
required capabilities. A task with artifacts cannot run on a provider that lacks
artifact collection. The executor applies the task's cleanup policy precisely:
`always` cleans up after either result, `on-success` cleans up only after a
successful task, and `never` leaves the target running for inspection or reuse.
Task prompts, command arguments, credentials, command output, and artifact
contents are not written to the default CLI summary or lifecycle events.

## Local smoke test

From this repository, verify the orchestration layer without requiring Docker
Sandboxes or cloud credentials:

```bash
npm install
npm run typecheck
npm run test:run
npm run build

# Inspect the CLI contract.
node dist/cli/index.js --help

# Compile the included demonstration against both providers.
(cd examples/orchestration-demo && node ../../dist/cli/index.js plan local review)
(cd examples/orchestration-demo && node ../../dist/cli/index.js plan secure review)
```

To smoke-test a project target, create a target and task as above, then run:

```bash
biodome config validate
biodome plan local review-pr
biodome build local
biodome run local review-pr
```

For Docker Sandboxes, first verify `sbx version` and `sbx login`, then replace
`local` with `secure-local`. Running against a real agent may consume provider
credits and use the credentials available to that target.

# Application declarations

Before a target and task are selected, Biodome loads services, implicit apps,
and then features. Apps are authoring sugar only: they expand to the existing
portable plan primitives before orchestration compiles an execution plan. This
keeps a task portable across providers without framework-specific runtime code.
