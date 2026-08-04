# Plan 04: Introduce a Deep Plan Builder

Status: proposed. This is a structural change and must be implemented in small migrations.

## Objective

Replace the 1,500-line `SandboxContext` responsibility bundle with a narrow public context backed by domain modules that own validation, normalization, invariants, and derived plan contributions.

## Dependencies

- Complete Plan 05 first so domain modules can consume canonical schemas.
- Prefer completing Plan 02 first so generated process paths are already centralized.

## Files

- Modify `src/core/context.ts` and `src/core/feature.ts`.
- Add modules below `src/core/plan-builder/`.
- Move focused tests from `src/tests/core/context.test.ts` into matching domain test files.
- Keep a small context integration test.

## Locked Decisions

- `FeatureContext` must not expose mutable `plan`.
- Keep the user-facing primitive method names unless a separate plan explicitly changes them.
- Do not split code into thin forwarding files. Each domain module owns complete rules for its primitives.
- `PlanBuilder` is the only object allowed to expose the final normalized `Plan`.
- Filesystem reads and command execution are injected capabilities, not imported directly by domain modules.

## Target Module Responsibilities

- `plan-builder.ts`: owns state, finalization order, and final `Plan` retrieval.
- `processes.ts`: processes, hooks, ports, health checks, environment merging.
- `build.ts`: languages, packages, tools, dependency files, snippets, artifacts.
- `services.ts`: services, service volumes, service-derived settings.
- `environment.ts`: env declarations, secret references, scopes, interpolation rules.
- `volumes.ts`: volume unions, credentials, rclone configuration, mount processes.
- `providers.ts`: endpoints, MCP providers, LLM providers.
- `harnesses.ts`: OpenCode, Pi, Codex, Claude normalization and derived dependencies.
- `repositories.ts`: repo validation, dependencies, and sync hooks.
- `project-io.ts`: injected `fileExists`, `readFile`, `readJSON`, and `exec` implementation.

## Implementation Steps

1. Add a `PlanBuilder` that initially wraps the existing `SandboxContext` without behavior changes.
2. Remove `plan` from `FeatureContext`; update internal callers to obtain the final plan from the builder.
3. Add a typed `ProjectIO` interface and a live Node implementation.
4. Migrate one domain at a time in this order: environment, processes, services, repositories, volumes, providers, harnesses, build.
5. For each migration, move its validation and normalization tests before deleting old code.
6. Keep primitive methods on the public context as closures bound to the responsible domain module.
7. Replace array-based duplicate checks with private name registries only where they simplify invariants; do not optimize without need.
8. Move final build-language processing into the build domain.
9. Delete migrated private methods and imports from `context.ts` after each domain passes tests.
10. End with `context.ts` containing public API assembly only and no domain validation logic.

## Required Tests

- One test file per domain module covering success, defaults, invalid input, duplicates, and derived contributions.
- A `ProjectIO` fake test for manifest detection and dry-run execution.
- Context integration test proving multiple primitive domains compose into one plan.
- Existing builder and generator tests unchanged unless expected normalized output intentionally changes.

## Acceptance Criteria

- `FeatureContext` exposes behavior, not mutable plan representation.
- No plan-builder domain imports `node:fs` or `node:child_process` directly.
- Each primitive's complete rules are located in one domain module.
- `SandboxContext` is removed or reduced to a small facade under 250 lines.
- All public primitive behavior remains covered by tests.

## Non-Goals

- Converting feature modules to Effect programs.
- Adding backward-compatibility adapters for direct `ctx.plan` mutation.
- Changing generated Docker output.

## Verification

```bash
npm run check
npm run build
npm run test:integration
```
