---
name: extend-biodome
description: Use when adding a new biodome primitive to this codebase — a backing service (mysql, mongodb), a tool (kubectl-style), a language runtime, a package manager, or a brand-new ctx.addX() context method. Triggers include "add a service", "add a tool", "add a language", "new primitive", "extend biodome", serviceConfigs, toolHandlers, languageHandlers, addService, addProcess.
---

# Extending biodome

biodome turns composable JS/TS primitives into a `Plan`, then generators emit a
Dockerfile, compose file, supervisord config, and health checks. Features call
`ctx.addX(...)` methods; each method mutates the shared `Plan`.

This skill is for extending biodome **itself** (the code under `src/`), not for
authoring `biodome/features/*.mjs` in a downstream project.

## Read before writing

Verify current patterns in the source instead of coding from memory:

- `src/core/plan.ts` — `Plan` shape, `create Plan`, and all `Schema` validators.
- `src/core/context.ts` — `SandboxContext`, the runtime home of every `ctx.addX()`.
- `src/core/feature.ts` — the `FeatureContext` interface (public primitive surface).
- `src/core/{services,tools,languages,packages}.ts` — the registries.
- `src/docker/generator.ts` — how the `Plan` becomes Docker/compose/supervisord.
- `src/core/info.ts` — `info` / `AGENTS.md` output and service connection strings.

This repo uses Effect v4 `Schema` for validation. Load the `effect` skill when
touching schemas or Effect service code.

## Pick the extension type

| You are adding…                    | Primary file(s)                              | Pattern              |
| ---------------------------------- | -------------------------------------------- | -------------------- |
| Backing service (mysql, mongodb)   | `src/core/services.ts`, `src/core/info.ts`   | Registry entry       |
| Tool / apt-installed CLI           | `src/core/tools.ts`                          | Registry entry       |
| Language runtime                   | `src/core/languages.ts`                      | Registry entry       |
| Package manager                    | `src/core/context.ts` (`addPackage`)         | Registry entry       |
| Net-new `ctx.addX()` primitive     | `feature.ts` + `context.ts` + `plan.ts` + generator | Full flow    |

Every change requires **code + tests + docs**. See the checklist at the end.

---

## Registry-style additions

These extend an existing primitive by adding a keyed entry to a lookup table.
Unknown keys already have sensible fallbacks (services/tools default to a plain
image/apt package; languages are ignored; unknown package managers throw), so
you are opting a name into richer behavior.

### Backing service

1. Add a `serviceConfigs` entry in `src/core/services.ts`. The callback receives
   the base `Service` and validated `ServiceOptions`; mutate `svc.environment`,
   `svc.volumes`, and `svc.healthCheck`. Follow the `postgres`/`redis` entries.
2. Add a `defaultImages` entry (e.g. `mysql: "mysql:8"`).
3. If the service exposes a connection string, add a branch to
   `serviceConnection` in `src/core/info.ts` (used by `biodome info` and the
   generated `AGENTS.md`).
4. If new option fields are needed (like postgres `databases`/`users`), extend
   `ServiceOptionsSchema` in `src/core/plan.ts`.

Note: `addService` in `context.ts` keys `serviceConfigs` by service `type`.
When the user passes a custom `image`, `type` becomes `"container"` and the
config lookup is skipped — a named service must use the default image to pick up
its config.

### Tool

Add a `toolHandlers` entry in `src/core/tools.ts`. The callback gets the
`BuildContext`; use `ctx.addAptPackage(...)` for apt packages and
`ctx.addLanguageSnippet("RUN ...")` for custom install/verify steps. Unknown
tool names fall through to apt in `context.ts`, so only register tools that need
more than a plain `apt-get install`.

### Language runtime

Add a `languageHandlers` entry in `src/core/languages.ts` implementing
`LanguageHandler`:

- `baseImage(options)` — image for single-language mode (e.g. `node:20-slim`).
- `installRuntime(ctx, options)` — install the runtime on the neutral
  `debian:12-slim` base for multi-language mode. Use `ctx.addRuntimeInstall(...)`.
- `installDependencies(ctx, options)` — detect manifests with
  `ctx.requireDependencyFiles([...])`, then `ctx.addDependencyInstall(...)` and
  `ctx.addCopyArtifact(...)` to move built deps into the final stage.

Mirror an existing handler closely (python/node show manifest detection; go/rust
show cache-path env vars needed in multi-language mode). Also update the
documented language list in `docs/api.md`.

### Package manager

Add a key to the `commands` map inside `addPackage` in `src/core/context.ts`.
Use `formatPackage(name, options, sep)` from `src/core/packages.ts` for
version pinning, and honor `options.indexUrl` where the manager supports it.
Update the documented manager list in `docs/api.md`.

---

## Net-new context primitive (full flow)

Adding a method like `ctx.addSecret(...)` touches every layer. Do them in order:

1. **Plan model** (`src/core/plan.ts`): add fields to `BuildPlan`/`RuntimePlan`
   (or a new interface), initialize them in `createPlan`, and extend `PlanSchema`
   so the plan still validates.
2. **Input schema** (`src/core/plan.ts`): add a `Schema.Struct` spec validator
   for the method's arguments (see `ProcessSpecSchema`, `ServiceOptionsSchema`).
3. **Type export** (`src/core/feature.ts`): export the spec type from the schema
   and add the method to the `FeatureContext` interface.
4. **Implementation** (`src/core/context.ts`): implement the method on
   `SandboxContext`. Decode input with `Schema.decodeSync(...)`, validate with the
   local `validatePort` / `validateEnv` helpers, enforce uniqueness, throw
   `ValidationError` from `src/core/errors.ts` on bad input, then mutate `this.plan`.
5. **Generator** (`src/docker/generator.ts`): consume the new plan fields so they
   affect the Dockerfile / compose / supervisord output.
6. **Info surfaces** (`src/core/info.ts`): reflect the primitive in `formatInfo`
   and `formatAgentsMd` if it is user-visible.

Keep handlers thin and push reusable logic into a registry module (like
`services.ts`) when a primitive has per-name behavior.

---

## Tests

Tests live under `src/tests/`, mirroring `src/` (`vitest`, `describe/it/expect`).

- Primitive/context behavior → `src/tests/core/context.test.ts` (build a
  `SandboxContext`, call the method, assert on `ctx.plan`). Use the `makeProject`
  temp-dir helper for anything touching manifest detection.
- Generator output → `src/tests/docker/generator.test.ts`; snapshot changes land
  in `src/tests/docker/generator.snapshot.test.ts` (update snapshots
  intentionally, not blindly).
- Info / connection strings → `src/tests/core/info.test.ts`.

Cover the happy path, the fallback/default path, and at least one validation
error. For a new language, add it to the multi-language `it.each` matrix in
`context.test.ts`.

## Docs

Update the relevant docs under `docs/`:

- New primitive method → `docs/primitives.md` and `docs/api.md`.
- New service → `docs/file-layout.md` (services section).
- New language / package manager → `docs/api.md` (enumerated lists).
- Processes/hooks/lifecycle behavior → `docs/processes.md`.

## Verify

Run from the repo root:

```bash
npm run typecheck
npm run test:run
```

Both must pass. `npm run test:integration` builds real Docker images and is
usually not needed for a plan/generator change.

## Checklist for every addition

- [ ] Implementation added following the nearest existing pattern
- [ ] Input validated via `Schema` + `ValidationError`, with a sane fallback for unknown keys
- [ ] Plan schema (`PlanSchema`) still validates any new fields
- [ ] Generator / info surfaces updated if the primitive is user-visible
- [ ] Tests added (happy path, fallback, validation error); snapshots updated intentionally
- [ ] Docs updated under `docs/`
- [ ] `npm run typecheck` and `npm run test:run` pass
