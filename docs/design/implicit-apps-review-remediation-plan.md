# Implicit Apps Review Remediation Plan

Status: ready for implementation

## Objective

Close the five review findings in the implicit apps implementation while preserving
the public `@kotarcreative/biodome/app` API, deterministic plans, provider-neutral
expansion, and existing feature-only behavior.

## Workstream 1: Harden npm Package Specs

Ownership:

- `src/apps/package-manager.ts`
- `src/tests/apps/package-manager.test.ts`

Requirements:

1. Continue accepting normal unscoped and scoped npm package names, optionally with
   valid npm semver versions, tags, or ranges.
2. Reject filesystem paths, `file:` specs, HTTP(S) URLs, Git URLs/specs, npm aliases,
   flags, whitespace, and shell metacharacters.
3. Keep all npm execution through `execFileSync` argument arrays with `.biodome` as
   the working directory.
4. Ensure removal resolves only the validated package name.
5. Add table-driven tests covering accepted and rejected inputs, including scoped
   packages and versions.

Verification:

```bash
npx vitest run src/tests/apps/package-manager.test.ts
npm run typecheck
```

## Workstream 2: Complete Scoped Builder Semantics

Ownership:

- `src/apps/application-builder.ts`
- `src/apps/types.ts` only if necessary
- `src/tests/apps/application-builder.test.ts`
- relevant app documentation if behavior needs clarification

Requirements:

1. Apply `ServiceBinding.environment` instead of silently discarding it. Each map
   entry maps the application environment variable name to the referenced service
   environment key. Resolve through existing service/environment primitives; do not
   copy resolved secret values into application metadata or provenance.
2. Validate referenced service environment keys and produce an error naming the app,
   service, and invalid key where existing service metadata makes validation possible.
3. Always namespace newly declared hooks, processes, and endpoints as
   `<app-name>:<local-name>` and reject local declaration names containing `:`.
4. Preserve already-qualified process names only in endpoint reference fields.
5. Add tests for binding behavior, invalid bindings, namespace escape attempts, and
   qualified endpoint process references.

Verification:

```bash
npx vitest run src/tests/apps/application-builder.test.ts
npx vitest run src/tests/core/context.test.ts
npm run typecheck
```

## Workstream 3: Transactional Expansion and Recipe Version Provenance

Ownership:

- `src/apps/loader.ts`
- `src/apps/types.ts`
- `src/apps/recipe.ts`
- provenance/formatting modules under `src/apps/`
- loader, recipe, format, and end-to-end tests under `src/tests/apps/`

Requirements:

1. Keep discovery, dependency validation, and cycle validation ahead of expansion.
2. Expand apps against isolated temporary plan state. Commit the expanded state to
   the real builder only after every app and reference passes validation, so failures
   cannot leave partial mutations.
3. Preserve established `PlanBuilder` validation/deduplication behavior; do not
   manually duplicate primitive mutation logic.
4. Keep expansion order deterministic and preserve services-before-apps and
   apps-before-features ordering.
5. Add an optional recipe version to the recipe contract or derive it reliably from
   the imported distributed package without scanning `node_modules` recursively.
6. Carry the version into `Application.recipe.version`, contribution provenance,
   inspection output, serialized plans, and therefore plan digests. Local recipes may
   omit it.
7. Add regression tests proving a failed service/endpoint reference does not mutate
   the caller's plan and proving recipe versions appear in inspection/provenance.

Verification:

```bash
npx vitest run src/tests/apps/loader.test.ts src/tests/apps/recipe.test.ts \
  src/tests/apps/format.test.ts src/tests/apps/end-to-end.test.ts
npx vitest run src/tests/builder/index.test.ts src/tests/core/plan.test.ts
npm run typecheck
```

## Integration and Acceptance

After all workstreams land:

1. Review changes for conflicting edits, especially `src/apps/types.ts`.
2. Update public documentation for any clarified binding or recipe-version contract.
3. Run `npm run check`.
4. Run `git diff --check`.
5. Run the existing local app demo workflows.
6. Run Docker integration if the environment remains available; report any external
   infrastructure limitation separately from code failures.

Acceptance criteria:

- Unsafe npm sources are rejected before invoking npm.
- Service bindings produce usable application environment entries.
- App declarations cannot escape their namespace.
- Failed app expansion is atomic from the caller's perspective.
- Distributed recipe versions are visible in plan metadata and provenance.
- All existing tests and package export checks remain green.
