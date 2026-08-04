# Plan 06: Extract Shared Runtime Artifact Rendering

Status: proposed. Complete before splitting the Docker generator.

## Objective

Generate common runtime files once and let each driver add only backend-specific artifacts.

## Dependencies

- Complete Plan 02 first.

## Files

- Add `src/runtime/artifacts.ts`.
- Add `src/runtime/artifact-writer.ts` if writing is not kept in the same module.
- Modify `src/runtime/docker-compose.ts`.
- Modify `src/runtime/aws-ecs.ts`.
- Reuse functions from `src/docker/generator.ts` initially.
- Add `src/tests/runtime/artifacts.test.ts`.

## Locked Decisions

- Renderers return data; only the writer touches the filesystem.
- Use one `GeneratedFile` type for text, copied source files, and executable mode.
- Relative artifact paths must be validated against traversal before writing.
- Common artifacts include Dockerfile, supervisor config, health checks, repo scripts, harness files, MCP plan/server, and Docker ignore content.
- Compose YAML remains Docker Compose-specific.
- ECS API calls remain ECS-specific.

## Required Interface

```ts
interface GeneratedFile {
  readonly relativePath: string
  readonly content?: string
  readonly sourcePath?: string
  readonly mode?: number
}

renderCommonArtifacts(plan: Plan, layout: RuntimeLayout): readonly GeneratedFile[]
writeArtifacts(outputDir: string, files: readonly GeneratedFile[]): Effect.Effect<readonly string[], RuntimeError>
```

Exactly one of `content` and `sourcePath` must be present.

## Implementation Steps

1. Add `GeneratedFile` and validate its invariants in tests.
2. Add a pure common renderer by moving the duplicated render sequence out of both drivers.
3. Make generated file ordering deterministic by sorting on `relativePath`.
4. Add a writer that creates parents, writes or copies files, and applies mode.
5. Reject absolute and traversal-containing relative paths before filesystem writes.
6. Update Docker Compose render to write common artifacts, then append Compose YAML.
7. Update ECS render to write the same common artifacts without Compose YAML.
8. Remove duplicated helper functions such as `writeBuildFile` from both drivers.
9. Keep driver error messages specific by mapping writer errors at the driver boundary.

## Required Tests

- Pure renderer snapshot or explicit file-manifest test.
- Deterministic ordering test.
- Writer text, copy, executable, parent-directory, and traversal tests.
- Driver tests proving Compose adds YAML and ECS does not.
- Equality test proving common manifests from Compose and ECS match for one plan.

## Acceptance Criteria

- Common artifact generation exists in one implementation.
- Neither runtime driver manually loops over harness or health-check generators.
- Filesystem behavior is tested independently from driver behavior.
- Driver render outputs remain functionally equivalent.

## Non-Goals

- Splitting every generator function into separate files.
- Making filesystem writes concurrent.
- Changing generated file contents.

## Verification

```bash
npm run check
npm run build
npm run test:integration
```
