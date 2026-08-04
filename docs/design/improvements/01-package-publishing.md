# Plan 01: Fix Package Publishing

Status: complete. Implemented in commit `779eb71`.

## Objective

Publish only the files needed by Biodome, and make every declared package entry point exist and load successfully.

## Current Problem

- `package.json` declares `dist/index.js` and `dist/index.d.ts`, but there is no `src/index.ts`.
- `npm pack --dry-run` includes `.opencode/references/effect-smol` and thousands of development files.
- There is no automated test that installs the tarball and imports the package.

## Dependencies

None.

## Files

- Modify `package.json`.
- Add `src/index.ts`.
- Add `src/tests/package/package.test.ts` or an equivalent package smoke-test script.
- Add `LICENSE` if the repository still has no license file; use the MIT text declared by `package.json`.
- Modify `.gitignore` only if the smoke test creates a persistent temporary artifact.

## Locked Decisions

- Use the `files` field in `package.json`; do not maintain a large `.npmignore` denylist.
- Publish `dist`, `README.md`, and license files only.
- Add an explicit `exports` map instead of relying only on `main` and `types`.
- Keep the CLI entry at `dist/cli/index.js`.
- The public root module must export supported APIs intentionally. Do not export internal runtime drivers or mutable implementation classes by accident.

## Implementation Steps

1. Inventory imports used by documented programmatic consumers in `docs/api.md` and tests.
2. Add `src/index.ts` with explicit named exports for the supported public API.
3. Add an MIT `LICENSE` file if one is not present.
4. Add `package.json.files` with `dist`, `README.md`, and `LICENSE`.
5. Add `package.json.exports` entries for `.` and any documented public subpaths.
6. Keep `main` and `types` aligned with the root export for tooling that does not use `exports`.
7. Add `prepack` that runs the build. Do not run integration tests from `prepack`.
8. Add a smoke test that runs `npm pack` in a temporary directory, installs the tarball into a second temporary project, imports the root module, and runs `biodome --help`.
9. Assert that the packed file list contains no `.opencode`, `src`, `docs/design`, test, or generated build files.
10. Document the intended public imports in `docs/api.md`.

## Required Tests

- Root ESM import succeeds from an installed tarball.
- Exported API names match the documented list.
- Installed `biodome --help` exits successfully.
- The package contains fewer than 200 files and has no `.opencode` path.
- Every `exports`, `main`, `types`, and `bin` target exists after `npm run build`.

## Acceptance Criteria

- `npm pack --dry-run` includes only intentional release files.
- `dist/index.js` and `dist/index.d.ts` are generated.
- A clean temporary project can import and execute the packed package.
- No internal reference repository is published.

## Non-Goals

- Splitting cloud providers into separate packages.
- Changing CLI behavior.
- Supporting CommonJS consumers.

## Verification

```bash
npm run check
npm run build
npm pack --dry-run
```
