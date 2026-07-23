# Implementation Plan: End-To-End Local Task Runs

Status: completed. This milestone turns the existing target/task primitives into a proven, CI-tested workflow that runs a declared task in the complete Docker Compose development environment and returns only declared artifacts.

## Goal

Make this command reliable for a normal Biodome project:

```bash
biodome run local review-pr
```

The command must construct the selected target's full development environment, including its declared language runtime, dependency installation, workspace, runtime environment, daemon processes, services, and generated harness files. It must execute a named task in that environment, collect its declared output, and apply the task cleanup policy.

The completion proof is an integration test which invokes the built Biodome CLI, not driver methods or raw Docker commands. The fixture must use a harmless local harness shim and must never contact an LLM provider or require model credentials.

## Scope

In scope:

- Docker Compose targets only.
- One CLI integration fixture with a Pi harness name shadowed by a local shim.
- Full task lifecycle: preflight, render/build/start or reuse, execute, collect, cleanup, state inspection, and concise CLI output.
- Capability preflight, timeout enforcement in the Docker execution path, and bounded command output.
- Focused unit tests for the new behavior.
- Documentation of the supported local workflow and its limitations.

Out of scope:

- Calling a real LLM in tests or resolving model credentials during plan build.
- New task-harness families, arbitrary shell commands in task files, or OpenCode task support.
- ECS task execution, ECS artifact collection, or a remote artifact store.
- General event-log retention, rotation, or target-scoped log-file paths. Those belong to `security-performance-ergonomics-plan.md`.
- Changing the public target/task file model.

## Required Behavior

Given a project with `.biodome/targets/local.mjs` and `.biodome/tasks/review-pr.mjs`, running:

```bash
biodome run local review-pr
```

must perform these steps in this order:

1. Load and validate the target/task plan before Docker starts.
2. Reject an unsupported harness, missing `exec.command`, or missing `artifact.collect` (when artifacts are declared) before rendering, building, starting, or otherwise mutating a deployment.
3. Render target-scoped files below `.biodome-build/targets/local/` and verify Docker is available.
4. Read validated state. Reuse it only if the selected driver's `status` result is `running`; otherwise stop stale resources, remove stale state, render, build, start, and atomically write fresh state.
5. Execute the selected generated wrapper inside the `dev` container with its working directory set to `/workspace`.
6. Enforce the validated timeout against the process inside the container, not merely an outer JavaScript promise. A timeout must terminate the harness and produce a task failure.
7. Treat non-zero exit as failure. Only after a zero exit, collect exactly the declared relative artifact paths from `/workspace` into `.biodome-build/targets/local/artifacts/`.
8. Apply cleanup accurately: `always` after success or failure, `on-success` after a zero exit only, and `never` never automatically stops/removes state.
9. Print the target/task identity, result, and local artifact paths. Do not print the prompt, command arguments, credentials, task output, or artifact body.

## Implementation Rules

- Keep `executeTask` target-neutral. The CLI loads the plan and calls it; it must not duplicate deployment, task, or cleanup logic.
- Capability checks happen before any runtime action. `RuntimeDriver.exec` must not be called solely because a driver happens to have a method implementation.
- Preserve `RuntimeError` as the primary error. If cleanup fails after a task failure, log or attach cleanup context without replacing the task failure.
- Artifact paths remain schema-validated relative POSIX paths. Docker must reject invalid paths defensively too.
- Do not write prompt text, command arguments, credential values, command output, or artifact contents to lifecycle/task events.
- Do not add a test-only production harness primitive. The integration fixture must use the ordinary declared Pi harness and a fixture-local executable shim.

## Tasks

- [x] Task 1: Make Task Preflight Complete
- [x] Task 2: Bound Docker Task Execution
- [x] Task 3: Add A Real CLI Fixture
- [x] Task 4: Invoke The Built CLI And Assert The Contract
- [x] Task 5: Cover Reuse And Cleanup Semantics End To End
- [x] Task 6: Document The Proven Workflow

## Acceptance Criteria

- [x] `npm run test:integration` invokes the built `biodome run local review-pr` command against a fixture, with Docker as its only external dependency.
- [x] The task runs through a generated production harness wrapper, but the test harness never calls an LLM provider or needs credentials.
- [x] The resulting report demonstrates access to the fixture's language runtime, installed dependency, workspace source, declared environment, and daemon process.
- [x] The artifact is copied only from `/workspace/review.md` to the selected target's artifact directory after a successful task.
- [x] Missing required task capabilities fail before Docker deployment changes.
- [x] Task timeout terminates the in-container harness process and returns a bounded actionable failure.
- [x] `always`, `on-success`, and `never` cleanup behavior is covered at the appropriate unit/integration level.
- [x] Default CLI output and task events do not disclose task prompts, command arguments, credentials, output, or artifact contents.
- [x] `npm run check`, `npm run build`, and `npm run test:integration` pass.

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
