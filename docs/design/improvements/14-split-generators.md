# Plan 14: Split Generators by Complete Output

Status: proposed. This is an organization change after shared rendering exists.

## Objective

Replace the monolithic Docker generator with modules that each own one complete generated output or one harness family.

## Dependencies

- Complete Plan 06 first.
- Prefer Plan 02 first.

## Files

- Replace `src/docker/generator.ts` with modules below `src/docker/generators/`.
- Split tests below `src/tests/docker/generators/`.
- Keep a compatibility barrel only for internal imports during migration, then remove it if unnecessary.

## Locked Decisions

- Split by cohesive generated output, not by arbitrary helper size.
- Keep pure generation functions pure.
- Shared shell quoting and duration formatting live in one small utility module.
- Harness-specific configuration and scripts remain together.
- Generated output must not change during the mechanical split.

## Target Modules

- `dockerfile.ts`
- `compose.ts`
- `supervisor.ts`
- `healthchecks.ts`
- `repositories.ts`
- `harnesses/opencode.ts`
- `harnesses/pi.ts`
- `harnesses/codex.ts`
- `harnesses/claude.ts`
- `harnesses/shared.ts`
- `shell.ts`

## Implementation Steps

1. Capture current representative outputs with explicit tests or reviewed snapshots.
2. Extract shell quoting, duration parsing, and generated runtime path consumption.
3. Move Dockerfile generation and its focused tests.
4. Move Compose generation and its focused tests.
5. Move supervisor and health-check generation.
6. Move repository generation.
7. Move one harness family at a time with its tests.
8. Move shared telemetry writer and artifact-upload snippets only after two consumers require them.
9. Update the shared artifact renderer to import from final module paths.
10. Delete the monolithic implementation after all imports migrate.
11. Compare all captured outputs byte-for-byte.

## Required Tests

- Existing generator behavior tests moved without weakening assertions.
- Byte-for-byte regression fixtures for one full representative plan.
- Import-cycle check through successful build.
- Deterministic output test for each generator family.
- Shell quoting tests remain centralized.

## Acceptance Criteria

- No generator source file exceeds roughly 500 lines without a documented reason.
- Each module produces a complete artifact family.
- No generated output changes unintentionally.
- Runtime drivers import only the shared artifact renderer, not individual generators.

## Non-Goals

- Redesigning generated scripts.
- Introducing a template engine.
- Combining harnesses behind a generic abstraction that loses provider-specific behavior.

## Verification

```bash
npm run format
npm run check
npm run build
npm run test:integration
```
