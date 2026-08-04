# Plan 17: Harden Runtime Artifact Rendering

Status: proposed. Complete before additional runtime renderer or Docker generator refactors.

## Objective

Fix three correctness regressions in shared runtime artifact rendering:

1. Preserve a project-owned `.dockerignore` instead of overwriting it.
2. Validate output containment correctly on POSIX and Windows.
3. Make MCP-enabled rendering use a complete compiled runtime asset tree in development and published packages.

## Dependencies

- Plan 02 must be complete.
- The shared renderer from Plan 06 must exist in the current branch.
- Do not implement the broader MCP application refactor from Plan 07 in this plan.

## Files

- Modify `src/runtime/artifacts.ts`.
- Modify `src/runtime/layout.ts`.
- Modify `src/core/context.ts` only if required by the MCP server layout change.
- Modify `package.json`.
- Modify `src/tests/runtime/artifacts.test.ts`.
- Modify `src/tests/runtime/layout.test.ts`.
- Modify `src/tests/package/package.test.ts`.
- Modify `.github/workflows/ci.yml`.
- Update `package-lock.json` only if `npm install` changes it. This plan should not add a dependency.

## Baseline Commands

Run these before editing and record the results:

```bash
npm run typecheck
npm run test:run -- --run src/tests/runtime/artifacts.test.ts src/tests/runtime/layout.test.ts src/tests/package/package.test.ts
```

The baseline tests are expected to pass even though the regressions exist. The missing cases are part of this plan.

## Locked Decisions

- `.dockerignore` is project-owned once it exists. Biodome may create it only when it is absent.
- Add an explicit generated-file write policy. Do not special-case `.dockerignore` inside the filesystem writer by filename.
- The default write policy remains overwrite so existing Biodome-owned generated files continue to refresh.
- A preserved file is not included in the list returned by `writeArtifacts` because it was not written by the current render.
- Use `path.relative`, `path.isAbsolute`, and `path.sep` for containment. Do not compare paths with a hard-coded `/` or `\` prefix.
- Keep the pre-write checks that reject empty, absolute, and traversal-containing `GeneratedFile.relativePath` values.
- Do not add a bundler for the MCP server.
- Copy the compiled MCP server and every local JavaScript module it imports while preserving their relative directory structure.
- The MCP runtime entry point in a generated target is `mcp/server.js`, not the target root's `mcp-server.js`.
- `npm run dev` must build and execute `dist/cli/index.js` so development uses the same compiled runtime assets as the published package.
- Do not clean unrelated stale generated files in this plan.
- Do not change generated Dockerfile, Compose, plan JSON, or MCP protocol behavior except for the MCP server path required by the asset tree.

## Required Interfaces

Extend `GeneratedFile` with this policy:

```ts
export interface GeneratedFile {
  readonly relativePath: string;
  readonly content?: string;
  readonly sourcePath?: string;
  readonly mode?: number;
  readonly writeMode?: "overwrite" | "if-absent";
}
```

Use a pure path helper with behavior equivalent to:

```ts
function isPathWithin(outputRoot: string, outputPath: string): boolean {
  const pathFromRoot = relative(outputRoot, outputPath);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}
```

The implementation may accept a small path API parameter so tests can exercise `path.win32` while running on Linux. Do not export this helper from the package root.

## MCP Runtime Files

The generated target must contain this minimum tree:

```text
.biodome-build/targets/<target>/
  mcp/
    server.js
    provider-tools.js
    upstream.js
    volumes/
      adapter.js
      local.js
      s3.js
      gcs.js
      azure.js
```

Use one explicit, sorted constant for this runtime file list. Source files are resolved relative to the compiled `dist/runtime/artifacts.js` module, under `dist/mcp/`. Destination files are resolved below the target's host MCP directory.

Do not copy `generator.js` or `volumes/index.js`; the server does not import them. If an import in `src/mcp/server.ts` or one of the listed adapters changes, update the explicit runtime list in the same change.

## Implementation Steps

1. Add failing tests for all required behaviors before changing production code.
2. Add `writeMode` to `GeneratedFile`, defaulting to `"overwrite"` when omitted.
3. Mark the common `.dockerignore` artifact as `writeMode: "if-absent"`.
4. Update `writeArtifacts` to skip an existing `if-absent` destination without changing contents, mode, or timestamps.
5. Build the returned path array from files actually written. Do not return skipped paths.
6. Replace the hard-coded containment prefix check with the locked `path.relative` algorithm.
7. Add host and container MCP directory paths to `RuntimeLayout` and move `mcpServer` to `<mcp directory>/server.js`.
8. Add the explicit MCP runtime file list to `src/runtime/artifacts.ts` in sorted order.
9. When MCP is enabled, emit one copied-source `GeneratedFile` per MCP runtime file while preserving subdirectories.
10. Keep `plan.json` at its existing target-root location unless an existing test requires otherwise.
11. Update process commands and tests to use the new `layout.container.mcpServer` value. Avoid hard-coded duplicate paths.
12. Change `npm run dev` from source execution to `npm run build && node dist/cli/index.js`.
13. Extend the package test to prove every required `dist/mcp/*.js` runtime file is present in the packed tarball.
14. Add a Windows CI job that runs `npm ci`, `npm run typecheck`, and `npm run test:run`. Keep Docker integration on Ubuntu.
15. Run all verification commands and complete the report template from the improvements README.

## Required Tests

Add these cases to `src/tests/runtime/artifacts.test.ts`:

- Rendering with no `.dockerignore` creates the generated file and returns its path.
- Rendering with a pre-existing custom `.dockerignore` preserves its exact bytes and does not return its path.
- Normal nested output paths pass containment.
- `../escape`, sibling-prefix paths such as `/tmp/output-other/file`, and absolute paths fail containment.
- The containment helper accepts a nested Windows path such as `C:\project\.biodome-build\Dockerfile` when tested with `path.win32`.
- The containment helper rejects a Windows sibling path and a different-drive path.
- An MCP-enabled common manifest contains `plan.json` and every file in the required MCP runtime tree.
- Every MCP copied-source artifact has exactly one of `content` and `sourcePath`.
- Common artifact ordering remains deterministic after adding the MCP files.

Add these cases to `src/tests/runtime/layout.test.ts`:

- Host MCP server path is `.biodome-build/targets/<target>/mcp/server.js`.
- Container MCP server path is `/workspace/.biodome-build/targets/<target>/mcp/server.js`.

Add these assertions to `src/tests/package/package.test.ts`:

- The packed package contains all JavaScript files listed in `MCP Runtime Files` under `dist/mcp/`.
- The packed CLI still starts with `--help`.

Do not make unit tests depend on Docker or a network listener.

## Acceptance Criteria

- Rendering never modifies an existing `.dockerignore`.
- Rendering creates Biodome's `.dockerignore` when no file exists.
- Valid nested artifact writes work on POSIX and Windows.
- Traversal, sibling-prefix, absolute, and cross-drive paths are rejected.
- MCP-enabled rendering from the built CLI does not throw `ENOENT` for `server.js`.
- The generated MCP server can resolve all of its local module imports from the copied target tree.
- Development and published-package execution both use compiled runtime assets from `dist`.
- Compose and ECS continue to share the same common artifact manifest except for Compose YAML.
- The normal unit suite passes on Ubuntu and Windows CI.
- No production dependency is added.

## Non-Goals

- Refactoring the MCP server into a dependency-injected application.
- Changing MCP authentication, tools, adapters, or HTTP behavior.
- Bundling external SDKs into the MCP server.
- Adding support for new proxy volume providers.
- Cleaning old health-check, repository, harness, or MCP files from previous renders.
- Redesigning the artifact writer around asynchronous filesystem APIs.

## Verification

Run in this order:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run -- --run src/tests/runtime/artifacts.test.ts src/tests/runtime/layout.test.ts src/tests/package/package.test.ts
npm run test:run
npm run build
npm run test:integration
npm run dev -- --help
git status --short
```

`npm run dev -- --help` must build first and then print CLI help from `dist/cli/index.js`.

## Completion Report

Use this exact format:

```text
Plan: 17 Harden Runtime Artifact Rendering
Status: complete | partial | blocked
Files changed: <paths>
Behavior changed: <short factual list>
Tests added: <paths and cases>
Verification run: <commands and results>
Acceptance criteria not met: <none or exact items>
Follow-up discovered: <none or separate issue; do not expand current scope>
```
