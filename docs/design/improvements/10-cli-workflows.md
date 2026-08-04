# Plan 10: Extract CLI Workflows

Status: proposed. Migrate one command family at a time.

## Objective

Keep Commander responsible for parsing and presentation while testable workflow functions own lifecycle behavior.

## Dependencies

- Complete Plan 09 first.
- Prefer Plan 02 first for operation path construction.

## Files

- Reduce `src/cli/index.ts`.
- Add `src/cli/program.ts` for Commander wiring.
- Add `src/cli/workflows/target.ts`, `task.ts`, `config.ts`, and `events.ts` as needed.
- Add `src/cli/target-operation.ts`.
- Add focused tests below `src/tests/cli/workflows/`.

## Locked Decisions

- Workflow functions receive `rootDir`; they do not call `process.cwd()`.
- Workflow functions return structured results; they do not format console output.
- Commander action callbacks may log returned results.
- One helper builds a target operation context containing plan, target, driver, layout, and deployment ID.
- Capability checks stay in workflows, not Commander callbacks.
- Keep event wrapping and telemetry provisioning at one outer execution boundary.

## Required Context

```ts
interface TargetOperation {
  readonly rootDir: string;
  readonly plan: Plan;
  readonly target: RuntimeTarget;
  readonly driver: RuntimeDriver;
  readonly layout: RuntimeLayout;
  readonly deploymentId: string;
}
```

Create it through one Effect function that supports normal and dry-run plan loading.

## Implementation Steps

1. Extract `createTargetOperation` and test it with a fake driver registry.
2. Extract build, up, and down workflows without changing behavior.
3. Extract exec, logs, status, ps, and restart workflows.
4. Extract named task execution.
5. Extract config and target validation workflows.
6. Extract event querying after Plan 12 if Plan 12 is already complete; otherwise move current behavior unchanged.
7. Make `createProgram(dependencies)` return a Commander program without calling `.parse()`.
8. Keep `src/cli/index.ts` limited to creating live dependencies, creating the program, and parsing arguments.
9. Replace direct `console.log` in workflows with result values or Effect logging only for operational progress.
10. Remove repeated runtime input object construction from action callbacks.

## Required Tests

- Build workflow calls ensure, render, and build in order.
- Up workflow handles build and wait options.
- Down validates state before stopping.
- Capability failures happen before driver side effects.
- Restart-all handles each daemon and unsupported capabilities predictably.
- Program parsing tests verify arguments are passed to workflows.
- Workflow error tests preserve `SandboxError` subtypes.

## Acceptance Criteria

- `src/cli/index.ts` contains no lifecycle implementation.
- Core workflows can be tested without spawning the CLI.
- Target operation assembly exists in one place.
- Commander parsing and output remain compatible with documented commands.

## Non-Goals

- Replacing Commander.
- Redesigning command names or options.
- Moving driver lifecycle logic into the CLI.

## Verification

```bash
npm run check
npm run build
npm run test:integration
```
