# Plan 03: Complete Runtime Execution Contracts

Status: proposed. Priority: P0. Dependencies: Plan 02.

## Objective

Make `ExecutionPlan` the enforceable provider-neutral contract for task execution and
represent workspace delivery, secret exposure, build outputs, job execution, state,
and event scope explicitly before further ECS work.

## Current Baseline

- `Plan` is compiled into `ExecutionPlan` immediately before orchestration.
- Compatibility checks cover declared capabilities and optional resource maxima.
- Workspace, network, secret, service, and process requirements exist but are not all
  validated against provider support.
- `exec.command` conflates in-place execution with provider-native one-shot jobs.
- Build results are not passed durably to start or task execution.
- Some drivers read state files themselves instead of receiving validated state.
- Event paths are target-scoped, but lifecycle event payloads are not consistently
  scoped or emitted.

## Locked Decisions

- `Plan` remains the project/build IR; `ExecutionPlan` is the canonical portable task
  contract. Do not merge them.
- Provider compatibility must cover capabilities, workspace strategy, services,
  network mode, secret exposure, resources, and artifact transport.
- Split in-place execution from one-shot job execution. `biodome exec` means in-place
  execution; named remote tasks may use a job operation.
- Build output is a durable immutable manifest consumed by start/job operations.
- Runtime state is decoded and identity-checked once outside drivers, then passed as
  typed input.
- Drivers do not silently reinterpret unsupported requirements.
- Lifecycle and task events carry a common run/target/provider scope.
- Provider validation happens before rendering, building, or API calls.

## Files

- `src/core/capabilities.ts`
- `src/core/plan.ts`
- `src/runtime/driver.ts`
- `src/runtime/registry.ts`
- `src/runtime/state.ts`
- `src/orchestration/execution-plan.ts`
- `src/orchestration/compiler.ts`
- `src/orchestration/compatibility.ts`
- `src/orchestration/orchestrator.ts`
- `src/core/task-runner.ts`
- `src/core/events.ts`
- CLI target workflows and runtime contract tests

## Implementation Steps

1. Add explicit capabilities and optional driver interfaces for in-place exec and
   one-shot job execution.
2. Define provider-profile support for workspace strategies, service kinds, network
   modes, secret exposures, artifact transports, and resource bounds.
3. Extend compatibility reports with typed issue kinds for each requirement class.
4. Stop defaulting every non-sandbox provider to a bind workspace. Require an
   explicit supported strategy or a provider-specific safe default.
5. Compile actual secret requirements from the plan rather than emitting an empty
   list.
6. Define an immutable `BuildManifest` containing the exact image reference/digest,
   content identity, provider metadata, and creation time without secrets.
7. Persist and validate build manifests atomically under the target output directory.
8. Pass build manifests and validated deployment state into operations that require
   them.
9. Remove driver-local permissive state readers and make missing/corrupt/mismatched
   state a typed error.
10. Add a scoped event envelope or equivalent common metadata containing run ID,
    target, and provider.
11. Instrument driver operations once at the orchestration/workflow boundary with
    started, completed, and failed events.
12. Update target validation to run complete compatibility/provider preflight without
    writing output or contacting providers.

## Required Tests

- Driver contract tests enforce capability/method agreement for in-place exec and job
  execution independently.
- Compatibility tests reject unsupported workspace, service, network, secret,
  resource, and artifact requirements.
- Compiler tests do not silently select `bind` for remote providers.
- Build-manifest tests reject mutable or mismatched identities where an immutable
  digest is required.
- State tests reject wrong target, provider, deployment ID, and schema version before
  driver invocation.
- Event tests prove every lifecycle/task operation includes run, target, and provider
  scope without prompt or command leakage.
- Target validation tests prove incompatibilities fail before render or provider
  calls.

## Acceptance Criteria

- A provider cannot receive an execution plan containing an unsupported requirement.
- `biodome exec` and named one-shot jobs have distinct capability and operation paths.
- Start and job operations consume the exact durable build artifact selected by
  build.
- Drivers never recover from invalid state by treating it as empty state.
- Lifecycle events are consistently scoped and emitted for every built-in driver.

## Verification

```bash
npm run test:run -- src/tests/orchestration src/tests/runtime
npm run test:run -- src/tests/runtime/driver-contract.test.ts
npm run test:run -- src/tests/core/events.test.ts src/tests/cli/workflows
npm run check
npm run build
npm run test:integration
```
