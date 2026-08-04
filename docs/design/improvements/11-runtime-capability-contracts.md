# Plan 11: Narrow Runtime Capability Contracts

Status: proposed. Treat this as a type-system and testability change, not a driver redesign.

## Objective

Make supported runtime operations explicit in types so a capability declaration cannot disagree with a mandatory placeholder method.

## Dependencies

- Prefer Plan 10 first so CLI consumers are concentrated in workflow modules.

## Files

- Modify `src/runtime/driver.ts`.
- Modify `src/core/capabilities.ts`.
- Modify concrete drivers and registry types.
- Modify workflow and task-runner capability checks.
- Add `src/tests/runtime/driver-contract.test.ts` or focused type/runtime tests.

## Locked Decisions

- Preserve string capability IDs at reporting and validation boundaries.
- Internally define operation-specific interfaces.
- A driver does not implement an unsupported operation.
- Use type guards to refine a base driver after checking an operation capability.
- Keep lifecycle input and result types shared.

## Target Interfaces

Define small interfaces such as:

- `RenderableDriver`
- `BuildableDriver`
- `StartableDriver`
- `StoppableDriver`
- `ExecutableDriver`
- `ArtifactDriver`
- `StatusDriver`
- `LogDriver`
- `RestartDriver`

The base `RuntimeDriver` contains identity and declared capabilities. Concrete drivers implement intersections of supported interfaces.

## Implementation Steps

1. Define operation interfaces without changing concrete implementations.
2. Define capability-to-method validation in one function.
3. Add type guards such as `supportsExec(driver)` that check both declaration and method presence.
4. Update Docker Compose to satisfy all of its declared operation interfaces.
5. Update ECS to satisfy only supported operation interfaces.
6. Update task runner and CLI workflows to use type guards instead of checking a string and then calling a mandatory method.
7. Remove unsupported placeholder methods if any remain.
8. Validate drivers once when loaded by the registry and fail on inconsistent declarations.
9. Simplify test fakes so each test implements only operations it exercises.

## Required Tests

- Driver declaring a capability without its method is rejected.
- Driver implementing a method without declaring it follows the chosen policy; prefer rejection to avoid hidden behavior.
- Type guards permit the correct method call.
- Task preflight still rejects missing exec and artifact support before side effects.
- Docker Compose and ECS pass the shared driver validation suite.

## Acceptance Criteria

- Unsupported operations are absent, not dummy implementations.
- Capability checks refine types before operation calls.
- Driver test fixtures are smaller and operation-specific.
- Registry rejects inconsistent drivers immediately after loading.

## Non-Goals

- Changing capability names.
- Adding new runtime operations.
- Replacing structural TypeScript interfaces with classes.

## Verification

```bash
npm run check
npm run build
```
