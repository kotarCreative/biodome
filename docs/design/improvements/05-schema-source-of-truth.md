# Plan 05: Make Schemas the Domain Source of Truth

Status: complete. Implemented in commits `ef664ac`, `dc179dd`, and `f8ed1e6`.

## Objective

Define each plan concept once as a named Effect Schema and derive TypeScript types and the complete plan schema from those definitions.

## Current Problem

`src/core/plan.ts` repeats concepts as interfaces, input schemas, normalized schemas, and inline fragments in `PlanSchema`. Cross-field validation is then repeated in context methods.

## Dependencies

None.

## Files

- Split `src/core/plan.ts` into modules below `src/core/schema/` or `src/core/plan/`.
- Modify imports throughout `src`.
- Add or split tests below `src/tests/core/plan/`.

## Locked Decisions

- Use current Effect v4 Schema APIs already used by the repository.
- Derive types with `typeof SchemaName.Type`; do not maintain parallel interfaces.
- Use discriminated unions for volume variants.
- Keep input spec schemas separate from normalized plan schemas when their required/default fields differ.
- Compose `PlanSchema` from named exported schemas; do not repeat inline object definitions.
- Validation errors crossing the public API remain `ValidationError`, `ConfigError`, or `PlanError` as appropriate.

## Implementation Steps

1. Inventory every exported type and schema in `src/core/plan.ts` and record its consumers.
2. Extract shared scalar schemas: names, ports, durations, artifact paths, env names, lifecycle points, cleanup policy, and secret references.
3. Extract build schemas and derive `BuildPlan` and related types.
4. Extract process and service schemas and derive normalized types.
5. Replace `VolumeSpecSchema` with a discriminated union whose variants require their provider-specific fields.
6. Extract provider, repository, environment, and harness schemas.
7. Define cross-field schema checks for Env value/from XOR and other invariants currently checked manually.
8. Compose `RuntimePlanSchema`, `DeploymentPlanSchema`, and `PlanSchema` from named schemas.
9. Replace parallel interfaces with derived type aliases.
10. Update imports without introducing an index barrel that creates runtime cycles.
11. Remove manual validation that is now guaranteed by schema decoding, preserving only contextual checks such as duplicate names and port conflicts.
12. Add schema round-trip tests for a representative complete plan.

## Required Tests

- Valid and invalid tests for every scalar schema.
- One valid test per volume variant and missing-required-field tests per variant.
- Env XOR and scope tests at schema level.
- Input-to-normalized tests for defaults.
- Encode/decode round trip for a complete plan.
- Test that non-JSON-safe target options are rejected.

## Acceptance Criteria

- No domain concept has both a hand-written interface and equivalent schema shape.
- `PlanSchema` contains no large anonymous copies of exported schemas.
- Invalid volume combinations fail during schema decoding.
- Typecheck and all existing behavior tests pass.

## Non-Goals

- Changing the persisted plan format except where required to make invalid states unrepresentable.
- Replacing Effect Schema with another validation library.
- Reorganizing `SandboxContext`; that is Plan 04.

## Verification

```bash
npm run format
npm run check
npm run build
```
