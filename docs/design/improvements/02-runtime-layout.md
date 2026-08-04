# Plan 02: Centralize Runtime Paths

Status: complete. Implemented in commit `90c6b25`.

## Objective

Use one target-aware runtime layout for every generated host path and in-container path.

## Current Problem

`SandboxContext`, Docker generators, drivers, and CLI commands independently construct `.biodome-build` paths. Some process commands use root-level paths while target builds copy files below `targets/<target>`.

## Dependencies

None. Plan 06 depends on this plan.

## Files

- Add `src/runtime/layout.ts`.
- Add `src/tests/runtime/layout.test.ts`.
- Modify `src/core/context.ts`.
- Modify `src/core/task-runner.ts`.
- Modify `src/docker/generator.ts`.
- Modify `src/runtime/docker-compose.ts`.
- Modify `src/runtime/aws-ecs.ts`.
- Modify `src/cli/index.ts` only where it constructs runtime paths directly.

## Locked Decisions

- Define a serializable `RuntimeLayout` value; do not use global variables.
- Host paths and container paths must be separate fields.
- Target plans always use `.biodome-build/targets/<target>` on the host and `/workspace/.biodome-build/targets/<target>` in the container.
- Base plans without a deployment may use `.biodome-build` only for non-lifecycle generation tests.
- Do not store absolute host paths in `Plan` or `plan.json`.

## Required Interface

Create a function with this responsibility:

```ts
runtimeLayout(rootDir: string, targetName?: string): RuntimeLayout
```

The returned value must include host and container locations for the generated root, Dockerfile, Compose file, supervisor config, health checks, repository scripts, MCP plan/server, harness homes, artifacts, logs, and state.

## Implementation Steps

1. Add `RuntimeLayout` and `runtimeLayout` with no filesystem side effects.
2. Add table-driven tests for a base layout and a target layout.
3. Replace path assembly in Docker generator helpers with layout fields.
4. Change process normalization so generated commands reference layout-derived paths rather than hard-coded root-level paths.
5. Ensure repository hooks use the target-specific repository script path.
6. Ensure OpenCode, Pi, Codex, and Claude processes and task wrappers use the same target-specific homes.
7. Ensure the MCP process reads the target-specific `mcp-server.js` and `plan.json`.
8. Ensure ECS starts supervisor with the target-specific config path.
9. Replace CLI and task-runner target output path assembly with the host layout.
10. Search `src` for literal `.biodome-build` paths. Leave literals only in `layout.ts`, user-facing documentation, or tests explicitly checking output.

## Required Tests

- Base and target layout unit tests.
- Generator test asserting every generated supervisor command points below the selected target root.
- Generator test for repository, MCP, and all harness paths.
- Docker integration smoke test that starts one generated daemon from a named target.
- If MCP integration is too expensive, verify its process command and copied files in a focused driver test.

## Acceptance Criteria

- One module owns runtime path construction.
- No target process references root-level generated files.
- Docker Compose and ECS consume identical container artifact paths.
- Existing local task integration tests continue to pass.

## Non-Goals

- Changing the on-disk target layout.
- Introducing a virtual filesystem.
- Deduplicating the renderer; that is Plan 06.

## Verification

```bash
npm run check
npm run build
npm run test:integration
```
