# Implementation Plan: End-To-End Local Task Runs

Status: proposed. This is the next delivery milestone. It turns the existing
target/task primitives into a proven, CI-tested workflow that runs a declared
task in the complete Docker Compose development environment and returns only
declared artifacts.

## Goal

Make this command reliable for a normal Biodome project:

```bash
biodome run local review-pr
```

The command must construct the selected target's full development environment,
including its declared language runtime, dependency installation, workspace,
runtime environment, daemon processes, services, and generated harness files.
It must execute a named task in that environment, collect its declared output,
and apply the task cleanup policy.

The completion proof is an integration test which invokes the built Biodome CLI,
not driver methods or raw Docker commands. The fixture must use a harmless
local harness shim and must never contact an LLM provider or require model
credentials.

## Why This Is The Next Milestone

Target loading, Docker rendering, named task plans, harness wrappers, artifact
collection, and the `run` command already exist. The current Docker integration
test exercises them independently: it generates Compose files, starts Docker,
writes an artifact with `docker exec`, and copies it with `docker cp` itself.
It does not prove that `biodome run` builds a task plan, invokes the generated
harness wrapper, collects artifacts through the driver, or cleans up state.

Before claiming task execution is complete, the repository needs one executable
vertical slice through the public CLI plus the operational protections needed
for a task process that hangs or produces large output.

## Scope

In scope:

- Docker Compose targets only.
- One CLI integration fixture with a Pi harness name shadowed by a local shim.
- Full task lifecycle: preflight, render/build/start or reuse, execute, collect,
  cleanup, state inspection, and concise CLI output.
- Capability preflight, timeout enforcement in the Docker execution path, and
  bounded command output.
- Focused unit tests for the new behavior.
- Documentation of the supported local workflow and its limitations.

Out of scope:

- Calling a real LLM in tests or resolving model credentials during plan build.
- New task-harness families, arbitrary shell commands in task files, or OpenCode
  task support.
- ECS task execution, ECS artifact collection, or a remote artifact store.
- General event-log retention, rotation, or target-scoped log-file paths. Those
  belong to `security-performance-ergonomics-plan.md`.
- Changing the public target/task file model.

## Required Behavior

Given a project with `.biodome/targets/local.mjs` and
`.biodome/tasks/review-pr.mjs`, running:

```bash
biodome run local review-pr
```

must perform these steps in this order:

1. Load and validate the target/task plan before Docker starts.
2. Reject an unsupported harness, missing `exec.command`, or missing
   `artifact.collect` (when artifacts are declared) before rendering, building,
   starting, or otherwise mutating a deployment.
3. Render target-scoped files below `.biodome-build/targets/local/` and verify
   Docker is available.
4. Read validated state. Reuse it only if the selected driver's `status` result
   is `running`; otherwise stop stale resources, remove stale state, render,
   build, start, and atomically write fresh state.
5. Execute the selected generated wrapper inside the `dev` container with its
   working directory set to `/workspace`.
6. Enforce the validated timeout against the process inside the container, not
   merely an outer JavaScript promise. A timeout must terminate the harness and
   produce a task failure.
7. Treat non-zero exit as failure. Only after a zero exit, collect exactly the
   declared relative artifact paths from `/workspace` into
   `.biodome-build/targets/local/artifacts/`.
8. Apply cleanup accurately: `always` after success or failure, `on-success`
   after a zero exit only, and `never` never automatically stops/removes state.
9. Print the target/task identity, result, and local artifact paths. Do not print
   the prompt, command arguments, credentials, task output, or artifact body.

## Implementation Rules

- Keep `executeTask` target-neutral. The CLI loads the plan and calls it; it must
  not duplicate deployment, task, or cleanup logic.
- Capability checks happen before any runtime action. `RuntimeDriver.exec` must
  not be called solely because a driver happens to have a method implementation.
- Preserve `RuntimeError` as the primary error. If cleanup fails after a task
  failure, log or attach cleanup context without replacing the task failure.
- Artifact paths remain schema-validated relative POSIX paths. Docker must
  reject invalid paths defensively too.
- Do not write prompt text, command arguments, credential values, command output,
  or artifact contents to lifecycle/task events.
- Do not add a test-only production harness primitive. The integration fixture
  must use the ordinary declared Pi harness and a fixture-local executable shim.

## Task 1: Make Task Preflight Complete

Files:

- `src/core/task-runner.ts`
- `src/tests/core/task-runner.test.ts`

1. At the beginning of `executeTask`, after verifying that the task exists and
   before emitting `task.started` or touching state, require `exec.command`.
   Return a `RuntimeError` naming the driver and missing capability.
2. If `task.artifacts.length > 0`, require `artifact.collect` in the same
   preflight section. Move the current later check; it is too late because the
   task may already have started when the driver cannot collect its output.
3. Build the harness command during preflight. This rejects OpenCode and unknown
   harnesses before deployment creation. Retain the built command for execution;
   do not build it a second time in the CLI.
4. Keep task events metadata-only. Emit `task.started` only after preflight has
   passed, so invalid tasks do not appear as started tasks.
5. Add fake-driver tests for:
   - missing `exec.command` causes no render, build, start, exec, stop, or state
     write;
   - declared artifacts with missing `artifact.collect` cause no runtime calls;
   - an OpenCode task fails before runtime calls;
   - an artifact-free task succeeds with a driver that has only `exec.command`.

Verify:

```bash
npm run typecheck
npx vitest run src/tests/core/task-runner.test.ts
```

## Task 2: Bound Docker Task Execution

Files:

- `src/runtime/driver.ts`
- `src/runtime/docker-compose.ts`
- `src/core/task-runner.ts`
- `src/tests/runtime/docker-compose.test.ts` (new, unless an existing focused
  Docker driver test is a better fit)
- `src/tests/core/task-runner.test.ts`

1. Extend the `RuntimeDriver.exec` input with an optional, validated task-only
   timeout field, expressed in milliseconds or seconds. Use one unit throughout
   the interface; document it in the type. Normal `biodome exec` remains
   unbounded unless it explicitly supplies this field.
2. Pass the parsed `Task.timeout` from `executeTask` to `driver.exec`. Do not use
   an unbounded process wrapped only in `Effect.timeout`: cancelling the outer
   effect can leave `docker exec` and the agent alive in the container.
3. In the Docker Compose driver, enforce a supplied task timeout _inside_ the
   `dev` container. Use the image's standard `timeout` utility with a short kill
   grace period, or add a generated portable equivalent if every supported base
   image cannot provide it. The generated harness wrappers use `exec`, so the
   timeout process must directly control the harness/agent process.
4. Map timeout expiration to a non-zero result or a typed `RuntimeError` that
   lets `executeTask` emit exactly one `task.failed` event with
   `timed out after <task.timeout>`. Do not expose the full prompt or command.
5. Capture stdout/stderr with the same explicit byte limits used for MCP command
   execution. Return bounded strings in `CommandResult`; record neither string
   in normal task events or CLI output. On overflow, terminate the command and
   return an actionable bounded-output failure.
6. Keep interactive stdin disabled for tasks. The task wrapper receives the
   prompt as its one command argument; no terminal or user input is required.
7. Add focused driver tests using a fake child-process boundary or a Docker-gated
   test. Cover the exact Docker argument order, timeout wrapper insertion only
   when requested, non-zero exits, bounded output, and normal exec behavior
   without a timeout.
8. Update task-runner tests so timeout propagation asserts that the timeout value
   reaches `driver.exec`; retain the existing task-level error assertion.

Verify:

```bash
npm run typecheck
npx vitest run src/tests/core/task-runner.test.ts src/tests/runtime/docker-compose.test.ts
```

## Task 3: Add A Real CLI Fixture

Files:

- `src/tests/integration/local-task-execution.test.ts` (replace the current
  manual Docker workflow) or a focused adjacent integration test
- fixture helpers under `src/tests/integration/fixtures/` only if reuse avoids
  duplication

Build a temporary project that represents a real development environment:

```text
.biodome/
  config.json
  services.mjs
  features/dev.mjs
  targets/local.mjs
  tasks/review-pr.mjs
package.json
package-lock.json
src/app.mjs
bin/pi
```

The fixture must include all of the following:

1. A Node language/dependency declaration and a small checked-in application
   source file. The task report must prove Node can load the project dependency
   and read the application source from `/workspace`.
2. A daemon process declared through the normal Biodome process API. It must
   expose a localhost health endpoint or another deterministic readiness signal.
   The task report must prove that the daemon started under the generated
   supervisor configuration.
3. A non-secret runtime environment value declared through the normal Biodome
   environment API. The task report must prove the value reaches the task
   process.
4. A Pi harness named `reviewer`, with telemetry disabled for fixture clarity.
   Its generated wrapper is the production path being tested.
5. A fixture-local executable `bin/pi` that shadows the installed Pi command via
   an explicit fixture `PATH`. The shim must accept Pi's `-p <prompt>` shape,
   never call a network API, and write `/workspace/review.md`. Its report should
   contain fixed assertions about the source file, dependency, daemon readiness,
   and environment value. Do not make the assertion depend on the prompt value.
6. A task named `review-pr` with `harness: "reviewer"`,
   `artifacts: ["review.md"]`, a short valid timeout, and `cleanup: "always"`.

Do not use raw `docker compose`, `docker exec`, `docker cp`, the driver directly,
or `writeState` in the test body. Those bypass the behavior being proven.

## Task 4: Invoke The Built CLI And Assert The Contract

Files:

- `src/tests/integration/local-task-execution.test.ts`
- `vitest.integration.config.ts` only if its timeout or environment policy must
  change

1. Build the TypeScript CLI before integration tests. Invoke the built entry
   point with Node from the temporary fixture root:

   ```bash
   node <repository-root>/dist/cli/index.js run local review-pr --no-events
   ```

   If Commander requires global options before the command, use the repository's
   established invocation order and document it in the test.

2. Capture stdout/stderr with a timeout appropriate for image creation. On test
   failure, include bounded process output in the assertion message for CI
   diagnosis, but do not assert or print sensitive fixture inputs.
3. Assert exit code zero and concise output containing the target/task identity
   and `artifacts/review.md`. Assert that it does not contain the fixture prompt
   or full generated wrapper command.
4. Assert the artifact is exactly at:

   ```text
   .biodome-build/targets/local/artifacts/review.md
   ```

   Read it and assert the fixed full-environment evidence produced by the shim.

5. Assert `state.json` is absent after the command due to `cleanup: "always"`.
   Query Docker Compose using the deterministic deployment ID only in test
   teardown/assertion code to confirm no `dev` container remains running.
6. Make cleanup idempotent in `afterEach`/`afterAll`: if the CLI fails halfway,
   use the known target output/Compose project to remove containers and delete
   the temporary project. Never leave CI containers behind.
7. Retain a separate two-target rendering assertion, but make it call the Docker
   driver render path or the CLI target commands rather than hand-writing Compose
   files.

Verify locally with Docker available:

```bash
npm run build
npm run test:integration
```

## Task 5: Cover Reuse And Cleanup Semantics End To End

Files:

- `src/tests/integration/local-task-execution.test.ts`
- `src/tests/core/task-runner.test.ts`

Add the smallest set of cases needed to prevent lifecycle regressions:

1. **Reuse:** run a task with `cleanup: "never"`, then run it again. Assert the
   second run observes the same running deployment ID and does not issue a
   Docker build/start. Use a marker written by the fixture shim or spy at the
   driver unit-test level; do not infer this only from elapsed time.
2. **Always cleanup after failure:** make the shim exit non-zero after writing no
   artifact. The command must fail, must not copy an artifact, and must stop the
   deployment/remove state.
3. **On-success retention after failure:** use a task fixture with
   `cleanup: "on-success"` and a failing shim. The command must fail while the
   deployment and validated state remain for diagnosis. Explicit teardown then
   removes them.
4. Keep cleanup-mode permutations that do not require Docker in the existing
   fake-driver unit tests. Do not multiply expensive Docker tests for every
   branch already proven at the task-runner level.

Verify:

```bash
npm run test:run
npm run test:integration
```

## Task 6: Document The Proven Workflow

Files:

- `README.md`
- `docs/index.md`
- `docs/file-layout.md`
- `docs/processes.md`
- `docs/ROADMAP.md`
- `docs/design/local-task-execution-plan.md`

1. Document `.biodome/targets/<name>.mjs` and `.biodome/tasks/<name>.mjs` with a
   minimal Pi, Claude, or Codex task example. Never include a literal API key.
2. Document `biodome run <target> <task>`, artifact output paths, and the three
   cleanup modes.
3. State that OpenCode task execution is currently rejected and that ECS does
   not support task execution or artifact collection.
4. Explain that task prompts, credentials, command arguments, agent output, and
   artifact bodies are intentionally absent from normal lifecycle output/events.
5. Update the roadmap and the older local-task design plan only after every
   acceptance criterion below passes. Mark the manual Docker integration test as
   superseded by the CLI fixture.

Verify every lifecycle command in documentation includes a target:

```bash
rg -n "biodome (build|up|down|exec|logs|ps|status|restart|run)(\\s|$)" README.md docs
```

## Acceptance Criteria

- [ ] `npm run test:integration` invokes the built `biodome run local review-pr`
      command against a fixture, with Docker as its only external dependency.
- [ ] The task runs through a generated production harness wrapper, but the test
      harness never calls an LLM provider or needs credentials.
- [ ] The resulting report demonstrates access to the fixture's language runtime,
      installed dependency, workspace source, declared environment, and daemon
      process.
- [ ] The artifact is copied only from `/workspace/review.md` to the selected
      target's artifact directory after a successful task.
- [ ] Missing required task capabilities fail before Docker deployment changes.
- [ ] Task timeout terminates the in-container harness process and returns a
      bounded actionable failure.
- [ ] `always`, `on-success`, and `never` cleanup behavior is covered at the
      appropriate unit/integration level.
- [ ] Default CLI output and task events do not disclose task prompts, command
      arguments, credentials, output, or artifact contents.
- [ ] `npm run check`, `npm run build`, and `npm run test:integration` pass.

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
