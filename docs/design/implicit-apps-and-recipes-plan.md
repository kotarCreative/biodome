# Implementation Plan: Implicit Apps and Distributable App Recipes

Status: proposed. Audience: an engineer or smaller coding model implementing
this plan step-by-step. Complete tasks in order. Do not redesign the public API
while implementing. Run each task's focused verification before continuing.

## Goal

Make common application configuration concise without moving framework-specific
knowledge into Biodome core. Project applications are implicit entrypoints under
`.biodome/apps/`. Each app expands a local definition or an npm-distributed app
recipe into the existing portable primitives: languages, tools, packages,
repositories, environment, hooks, processes, endpoints, and service requirements.

The normal Django declaration should be approximately:

```javascript
// .biodome/apps/backend.mjs
import { django } from "@biodome/app-django";

export default django({
  repo: "github:acme/backend",
  database: { service: "postgres" },
  health: "/health/",
});
```

The filename supplies the app name `backend`. Users must not also write
`ctx.addRepo`, `ctx.addHook`, `ctx.addProcess`, and `ctx.addEndpoint` for the
conventional case.

## Decisions Already Made

- The implicit directory is `.biodome/apps/`, not `.biodome/recipes/`.
- Every immediate `.mjs` or `.js` file in `.biodome/apps/` is an app entrypoint.
- App files are discovered and loaded automatically, matching existing feature,
  target, and task conventions.
- One app file defines exactly one app. Its filename without the extension is the
  app name. An app module cannot override its name.
- App files may default-export either an app recipe value or a configuration
  function receiving an application-scoped builder.
- npm packages distribute reusable **app recipes**. Framework knowledge stays in
  those packages, not in Biodome core.
- Local edge cases use the same application builder directly in an app file.
- Reusable local helper modules belong in `.biodome/lib/` and are imported
  explicitly. `.biodome/lib/` is never implicitly loaded.
- Recipes expand into existing primitives. Runtime drivers and providers never
  need to understand Django, Angular, Rails, or any other framework.
- Expanded primitive names are app-scoped: `backend:web`, `backend:migrate`, and
  `backend:http`.
- App discovery is separate from expansion. Correctness must not depend on
  alphabetical file order.
- Cross-app and service references are serializable reference values, not live
  lookups performed while modules are imported.
- Expansion must preserve source provenance so `biodome app explain` can show why
  each primitive exists.
- App recipe dependencies are installed in `.biodome/package.json` with a
  `.biodome/package-lock.json`, separate from the application package manifest.
- Recipes are trusted host-side JavaScript, like existing feature modules. Do not
  describe them as sandboxed.
- Existing `.biodome/features/` remain supported as the low-level extension path.
- Do not ship Django or Angular recipes in this repository as part of this plan.
  Add only a small fixture recipe used to prove the public contract.

## Non-goals

- A proprietary recipe registry or marketplace. npm is the distribution layer.
- Automatic framework detection across arbitrary remote repositories.
- Executing untrusted recipe code safely.
- Supporting nested implicit app entrypoints. Only immediate files in `apps/`
  are loaded in this milestone.
- A generic plugin system for runtime drivers, MCP servers, or CLI commands.
- Implementing browser/computer-use support.
- Adding framework-specific core types.
- Automatically installing missing npm recipes during `build`, `plan`, or `run`.
- Supporting multiple apps from one app entrypoint.
- Allowing recipes to mutate targets or tasks.

## Desired Layout

```text
.biodome/
  config.json
  package.json
  package-lock.json
  services.mjs
  apps/
    backend.mjs
    frontend.mjs
  lib/
    company-django.mjs
  features/
    smoke-data.mjs
  targets/
    local.mjs
  tasks/
    smoke-feature.mjs
```

Loading order for the base project plan:

```text
1. config.json
2. services.mjs
3. discover apps/*.mjs and apps/*.js
4. register all app names and declarations
5. resolve app dependencies and expand apps
6. features/*.mjs and features/*.js
7. selected target
8. selected task
```

## Public Authoring API

### Distributed recipe

```javascript
// .biodome/apps/backend.mjs
import { django } from "@biodome/app-django";

export default django({
  repo: {
    url: "git@github.com:acme/backend.git",
    branch: "main",
  },
  database: { service: "postgres" },
});
```

### Local app

```javascript
// .biodome/apps/legacy-backend.mjs
export default function legacyBackend(app) {
  app.addLanguage("python", { version: "3.10" });
  app.addRepository({ url: "git@github.com:acme/legacy.git" });
  app.requireService("postgres", {
    environment: { DATABASE_URL: "DATABASE_URL" },
  });
  app.addHook("migrate", {
    command: ["python", "src/manage.py", "migrate", "--noinput"],
    phase: "start.pre",
  });
  app.addProcess("web", {
    command: ["python", "src/manage.py", "runserver", "0.0.0.0:8000"],
    port: 8000,
    health: "/internal/health/",
  });
  app.exposeEndpoint("http", { process: "web" });
}
```

### Cross-app reference

```javascript
// .biodome/apps/frontend.mjs
import { app } from "@kotarcreative/biodome/app";
import { angular } from "@angular/biodome-app";

export default angular({
  repo: "github:acme/frontend",
  api: app("backend").endpoint("http"),
});
```

### Reusable local recipe

```javascript
// .biodome/lib/company-api.mjs
import { defineAppRecipe } from "@kotarcreative/biodome/app";

export const companyApi = defineAppRecipe({
  id: "local/company-api",
  apiVersion: 1,
  expand(app, options) {
    app.addLanguage("python", { version: "3.12" });
    app.addRepository({ url: options.repo });
    app.addProcess("web", {
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      port: 8000,
    });
    app.exposeEndpoint("http", { process: "web" });
  },
});
```

## Architectural Boundaries

```text
apps/backend.mjs
        │
        ▼
AppDeclaration / AppRecipe
        │
        ▼
ApplicationBuilder (scoped facade)
        │
        ▼
existing FeatureContext / PlanBuilder methods
        │
        ▼
existing Plan + portable ExecutionPlan
        │
        ▼
runtime provider
```

Do not add an `apps` concept to runtime drivers. App identity and provenance may
remain in the plan as metadata, but all executable behavior must be expressed as
existing primitives before rendering begins.

## Task 1: Define App Contracts and Reference Values

Files:

- `src/apps/types.ts` (new)
- `src/apps/recipe.ts` (new)
- `src/apps/references.ts` (new)
- `src/apps/index.ts` (new)
- `src/tests/apps/recipe.test.ts` (new)
- `src/tests/apps/references.test.ts` (new)
- `package.json`

Add a package subpath export for `@kotarcreative/biodome/app`. Do not add the app
runtime to the existing root export; the root package API is intentionally small.

Required types:

```typescript
export const APP_RECIPE_API_VERSION = 1 as const;

export interface AppEndpointReference {
  readonly _tag: "AppEndpointReference";
  readonly app: string;
  readonly endpoint: string;
}

export interface ServiceReference {
  readonly _tag: "ServiceReference";
  readonly service: string;
}

export interface AppReferenceBuilder {
  endpoint(name?: string): AppEndpointReference;
}

export interface AppRecipe<TOptions = unknown> {
  readonly _tag: "AppRecipe";
  readonly id: string;
  readonly apiVersion: typeof APP_RECIPE_API_VERSION;
  readonly options: TOptions;
  readonly expand: (app: ApplicationBuilder, options: TOptions) => void | Promise<void>;
}

export interface AppRecipeDefinition<TOptions> {
  id: string;
  apiVersion: typeof APP_RECIPE_API_VERSION;
  expand(app: ApplicationBuilder, options: TOptions): void | Promise<void>;
}
```

Required helpers:

```typescript
defineAppRecipe<TOptions>(definition): (options: TOptions) => AppRecipe<TOptions>
app(name: string): AppReferenceBuilder
service(name: string): ServiceReference
```

Validation requirements:

- Recipe IDs and referenced names must be non-empty.
- App/service/endpoint names use the existing target-name character rules unless
  a narrower shared identifier validator already exists.
- Reject unsupported `apiVersion` with an error naming the recipe and versions.
- Reference helpers return frozen serializable values with no project lookup.
- `defineAppRecipe` must not execute `expand`.
- Avoid classes where a plain frozen object provides the same behavior.

Package export target:

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./app": {
      "types": "./dist/apps/index.d.ts",
      "import": "./dist/apps/index.js"
    }
  }
}
```

Update the package test to verify both exports and to keep the root runtime export
list unchanged.

Verification:

```bash
npx vitest run src/tests/apps/recipe.test.ts src/tests/apps/references.test.ts
npx vitest run src/tests/package/package.test.ts
npm run typecheck
```

## Task 2: Implement the Application-Scoped Builder

Files:

- `src/apps/application-builder.ts` (new)
- `src/apps/types.ts`
- `src/core/plan.ts`
- `src/core/plan-builder/plan-builder.ts`
- relevant domain modules under `src/core/plan-builder/`
- `src/tests/apps/application-builder.test.ts` (new)

Read the current `PlanBuilder`, feature context, and domain builder modules before
editing. Delegate to their public methods; do not duplicate their plan mutation
logic.

The builder must expose this initial surface:

```typescript
export interface ApplicationBuilder {
  readonly name: string;
  readonly root: string;

  addLanguage(name: string, options?: LanguageOptions): void;
  addTool(name: string, options?: ToolOptions): void;
  addPackage(manager: PackageManager, name: string, options?: PackageOptions): void;
  addRepository(options: AppRepositoryOptions): RepositoryRef;
  addEnvironment(key: string, spec: AppEnvironmentValue): void;
  requireService(name: string, binding?: ServiceBinding): ServiceReference;
  addHook(name: string, options: AppHookOptions): HookRef;
  addProcess(name: string, options: AppProcessOptions): ProcessRef;
  exposeEndpoint(name: string, options: AppEndpointOptions): EndpointRef;
}
```

Defaults and transformations:

- App root defaults to `/workspace/apps/<app-name>`.
- Repository name defaults to app name.
- Repository path defaults to app root.
- Hook and process working directories default to app root.
- Hook, process, and endpoint names become `<app-name>:<local-name>`.
- `exposeEndpoint("http", { process: "web" })` resolves the local process name to
  `<app-name>:web` and inherits its port when no port is supplied.
- A string process reference containing `:` is already qualified and must not be
  prefixed again.
- Reject duplicate local hook/process/endpoint names within an app before passing
  them to the underlying builder.
- Reject traversal or absolute overrides that escape the application root unless
  an existing primitive explicitly permits an absolute container path.
- Keep command arrays as arrays. Do not introduce shell-string commands.

Add application metadata to the plan only as needed for provenance and task
selection:

```typescript
interface Application {
  name: string;
  root: string;
  recipe?: { id: string; version?: string; declarationPath: string };
  repositories: string[];
  hooks: string[];
  processes: string[];
  endpoints: string[];
  requiredServices: string[];
  dependencies: string[];
}
```

Add `runtime.applications: Application[]` to the schema-derived plan. Do not place
functions or live references in the plan.

Verification cases:

- Namespacing for every named contribution.
- Default working directories and repository paths.
- Explicit working-directory override.
- Endpoint inherits its process port.
- Duplicate local name rejection.
- Two apps may both define a local process called `web` without collision.
- Underlying primitive validation still fires.
- Application metadata contains contributed primitive names.

Verification:

```bash
npx vitest run src/tests/apps/application-builder.test.ts
npx vitest run src/tests/core/context.test.ts src/tests/core/plan.test.ts
npm run typecheck
```

## Task 3: Implement Implicit App Discovery and Two-Phase Expansion

Files:

- `src/apps/loader.ts` (new)
- `src/apps/graph.ts` (new)
- `src/builder/index.ts`
- `src/core/errors.ts`
- `src/tests/apps/loader.test.ts` (new)
- `src/tests/apps/graph.test.ts` (new)
- `src/tests/builder/index.test.ts`

Discovery rules must match current feature conventions:

- Read immediate files from `.biodome/apps/`.
- Accept `.mjs` and legacy `.js`.
- Sort filenames for deterministic diagnostics and plan output.
- If both `<name>.mjs` and `<name>.js` exist, fail as ambiguous.
- Ignore non-JavaScript files and subdirectories.
- Validate app names from filenames.
- Importing a module evaluates its top-level code, matching existing trusted
  configuration behavior.
- Require exactly one supported default export.

Supported default exports:

```typescript
type AppModuleDefault = AppRecipe<unknown> | ((app: ApplicationBuilder) => void | Promise<void>);
```

Two-phase behavior:

1. Discover and import all modules.
2. Register app names and declarations without expanding any recipe.
3. Inspect serializable app references found in recipe options, if present.
4. Build a dependency graph.
5. Reject missing app references before plan mutation.
6. Reject dependency cycles with the complete readable cycle path.
7. Expand in deterministic topological order.
8. Run existing final plan validation.

Reference discovery must recursively inspect JSON-safe recipe options for
`AppEndpointReference` objects. It must not inspect arbitrary class instances or
execute getters. Recipe options must therefore be JSON-safe except for the frozen
plain reference objects defined in Task 1.

Local configuration functions cannot be statically inspected for dependencies.
They may call `app.requireAppEndpoint(app("backend").endpoint("http"))` while
expanding. To avoid partial mutation, give the builder access to the complete
registered app-name set and reject unknown references immediately. Do not attempt
to reorder local functions based on imperative calls in this milestone; their
explicit dependencies must be declared with an optional module export:

```javascript
export const dependsOn = ["backend"];
export default function frontend(app) {
  /* ... */
}
```

For recipe exports, merge `dependsOn` with dependencies inferred from options.

Cycle diagnostic example:

```text
Application dependency cycle: backend -> auth-proxy -> backend
```

Load apps after services and before features in `buildPlanEffect`.

Verification cases:

- Empty/missing apps directory is valid.
- App filename supplies identity.
- Both export forms expand.
- Async expansion is awaited.
- `.mjs`/`.js` ambiguity fails.
- Invalid default export fails with declaration path.
- Missing app reference fails before any app expansion.
- Alphabetically later dependency expands first.
- Cycle reports complete path.
- Repeated builds produce identical app and primitive ordering.
- A feature loaded after apps can see application metadata through a read-only
  context method if one is added.

Verification:

```bash
npx vitest run src/tests/apps/loader.test.ts src/tests/apps/graph.test.ts
npx vitest run src/tests/builder/index.test.ts
npm run typecheck
```

## Task 4: Resolve References and Record Provenance

Files:

- `src/apps/application-builder.ts`
- `src/apps/provenance.ts` (new)
- `src/core/plan.ts`
- `src/core/info.ts`
- `src/tests/apps/provenance.test.ts` (new)
- `src/tests/core/info.test.ts`

Implement resolution of:

- `ServiceReference` to a declared service.
- `AppEndpointReference` to a declared application endpoint.
- App-local process names used by endpoint declarations.

References must remain provider-neutral. Do not replace an app endpoint reference
with `localhost` during app expansion. Store the relationship in application
metadata and use the existing endpoint primitive for concrete information.

Every app-contributed primitive must record provenance without weakening existing
schemas. Prefer a shared optional field or a plan-level provenance index:

```typescript
interface ContributionSource {
  application: string;
  recipe?: string;
  recipeVersion?: string;
  declarationPath: string;
  localName: string;
}

interface ContributionProvenance {
  kind: "repository" | "hook" | "process" | "endpoint" | "language" | "tool" | "package";
  qualifiedName: string;
  source: ContributionSource;
}
```

A plan-level `runtime.contributions` list is preferred over adding source fields to
every existing primitive. Sort it deterministically.

Update project info formatting to include an Applications section but do not dump
all provenance in normal `biodome info` output.

Verification:

- Missing service reference has app and service names in its error.
- Missing endpoint reference has source app, target app, and endpoint names.
- Provenance records recipe ID and declaration path.
- Local app functions record declaration path without a recipe ID.
- No resolved secret appears in provenance.
- Plan JSON remains schema-valid and serializable.

## Task 5: Add App Inspection and Validation CLI Workflows

Files:

- `src/cli/index.ts`
- `src/cli/helpers.ts` or a new testable workflow module if Plan 10 has landed
- `src/apps/format.ts` (new)
- `src/tests/apps/format.test.ts` (new)
- CLI tests following the repository's current pattern
- `README.md`
- `docs/apps.md` (new)
- `docs/index.md`

Add:

```text
biodome app list
biodome app inspect <name> [--json]
biodome app validate
```

Do not implement npm installation commands in this task.

`app list` output:

```text
APP       RECIPE                         REPOSITORIES  PROCESSES  ENDPOINTS
backend   @biodome/app-django@1.2.0      1             1          1
frontend  @angular/biodome-app@2.0.0     1             1          1
```

`app inspect backend` output must include:

- Name and root.
- Recipe ID/version when present.
- Declaration file.
- Dependencies and required services.
- Repositories.
- Hooks.
- Processes.
- Endpoints.
- Contributions with qualified names.

`--json` prints only JSON to stdout. Read-only commands must build in dry-run mode
and must not execute feature `ctx.exec` commands.

`app validate` validates config, services, all apps, all features, references,
cycles, and the final plan without rendering or provisioning.

Verification:

- Stable human-readable snapshots.
- Stable JSON output.
- Unknown app error lists available app names.
- Read-only commands do not perform host command side effects.
- Help text contains the new command group.

## Task 6: Add `.biodome` npm Dependency Management

Files:

- `src/apps/package-manager.ts` (new)
- `src/cli/index.ts`
- `src/tests/apps/package-manager.test.ts` (new)
- CLI tests
- `.gitignore` generation logic if present
- `README.md`
- `docs/apps.md`

Add:

```text
biodome app add <package> [--no-scaffold]
biodome app remove <package>
```

Package layout:

```text
.biodome/package.json
.biodome/package-lock.json
.biodome/node_modules/       # ignored
```

`app add` requirements:

1. Validate package input as an npm package spec. Do not pass it through a shell.
2. Create `.biodome/package.json` when missing:

   ```json
   { "private": true, "type": "module", "dependencies": {} }
   ```

3. Execute npm with argument arrays and `cwd` set to `.biodome`.
4. Install an exact resolved version into the lockfile; normal semver range behavior
   in `package.json` is acceptable.
5. Read the installed package's `package.json` and require:

   ```json
   { "biodome": { "type": "app-recipe", "apiVersion": 1 } }
   ```

6. If metadata validation fails, report the problem. Do not silently treat an
   arbitrary package as an app recipe.
7. Do not automatically execute or import the installed package.
8. Print the trusted-code warning before installation when interactive. Support
   `--yes` for CI. If the current CLI has no prompt abstraction, require `--yes`
   initially rather than adding an ad hoc stdin implementation.
9. Ensure `.biodome/node_modules/` is ignored without ignoring
   `.biodome/package.json` or its lockfile.

`app remove` must call npm with argument arrays in `.biodome` and leave unrelated
dependencies untouched.

Scaffolding is intentionally minimal in this plan. With no standardized option
metadata, `app add` may print the import snippet instead of generating an app file:

```text
Installed @biodome/app-django@1.2.0
Create .biodome/apps/<name>.mjs and import the recipe from this package.
```

Only scaffold automatically when package metadata contains an explicit export and
template supported by a future schema. `--no-scaffold` is reserved now for forward
compatibility.

Tests must mock the child-process boundary; do not access the network in unit tests.

Verification:

```bash
npx vitest run src/tests/apps/package-manager.test.ts
npm run typecheck
```

## Task 7: Prove the Contract With a Fixture App Package

Files:

- `src/tests/fixtures/app-recipe-basic/` (new; choose the repository's normal
  fixture location if different)
- `src/tests/apps/end-to-end.test.ts` (new)
- `examples/apps-demo/` (new)
- `docs/apps.md`

Create a tiny fixture recipe package named `@biodome-test/app-basic`. It must use
the public `@kotarcreative/biodome/app` subpath and contribute:

- One repository.
- One process named `web`.
- One endpoint named `http` derived from that process.
- One optional service requirement.

Do not call it Django; its purpose is contract validation, not framework behavior.

Create an example project containing:

```text
.biodome/apps/api.mjs
.biodome/apps/web.mjs
.biodome/lib/local-worker.mjs
.biodome/services.mjs
```

The example must demonstrate:

- An npm-style fixture recipe.
- A local app function.
- Cross-app endpoint reference.
- Service reference.
- Namespaced primitives.
- `app list` and `app inspect` output.

End-to-end test assertions:

- Implicit discovery finds both apps.
- Dependencies expand in correct order independent of filenames.
- The computed plan has valid existing primitives.
- Names are scoped correctly.
- Application metadata and provenance are complete.
- `compileExecutionPlan` continues to work.
- Docker Compose rendering still succeeds.

## Task 8: Documentation and Compatibility Audit

Files:

- `README.md`
- `docs/index.md`
- `docs/apps.md`
- `docs/file-layout.md`
- `docs/api.md`
- `docs/orchestration.md`
- existing examples as needed

Document:

- Implicit app loading.
- One-app-per-file and filename identity.
- Distributed versus local app recipes.
- `.biodome/lib/` explicit imports.
- `.biodome/package.json` dependency isolation.
- Trusted-code security boundary.
- Namespacing and default roots.
- Cross-app and service references.
- Two-phase discovery/expansion.
- Inspection and validation commands.
- How apps expand into existing primitives.
- How low-level features extend app-generated behavior.

Audit all existing docs for file-layout trees and load-order statements. Do not
leave documentation implying that only services and features build the base plan.

## Required Test Matrix

Unit tests:

- Recipe definition and API version validation.
- Reference construction and serialization.
- Scoped builder defaults and namespacing.
- Loader discovery and module contracts.
- Dependency graph ordering and cycles.
- Provenance.
- Formatting.
- Package manager boundary.

Regression tests:

- Existing feature-only projects produce the same plan.
- Existing services load before apps.
- Existing features load after apps.
- Target and task loading remain unchanged.
- Existing package root runtime exports remain unchanged.
- Docker Compose, Docker Sandbox, and ECS renderers receive only expanded
  primitives and require no app-specific branching.
- Orchestration compiler accepts plans with or without applications.

Integration tests:

- Build a fixture app-expanded Docker image.
- Start a generated Compose environment when the fixture contains a process.
- Do not require a registry or network-installed third-party recipe.

## Security Requirements

- State clearly that app modules and npm recipes are trusted host-side code.
- Never install packages during `plan`, `build`, `up`, or `run`.
- Never shell-interpolate package names, app names, paths, or commands.
- Keep `.biodome/node_modules` out of Docker build contexts.
- Include recipe package/version and app declarations in the plan digest through
  deterministic application/provenance metadata.
- Do not store resolved secrets in app metadata or provenance.
- Validate module paths stay inside `.biodome/apps` during discovery.
- App references must not permit prototype pollution during recursive inspection;
  inspect own enumerable properties only and reject dangerous keys already
  rejected by the project's JSON-safe validation.

## Performance Requirements

- Import every app module at most once per plan build.
- Use one discovery pass and one graph sort.
- Detect cycles in O(apps + dependency edges).
- Do not walk `node_modules` during app discovery.
- Do not recursively scan `.biodome/apps`.
- Preserve deterministic ordering for stable plan digests and snapshots.

## Implementation Sequence and Checkpoints

Execute in this exact order:

1. Contracts and `./app` package export.
2. Scoped application builder.
3. Loader and dependency graph.
4. Reference resolution and provenance.
5. Read-only CLI inspection.
6. Explicit npm dependency management.
7. Contract fixture and end-to-end proof.
8. Documentation audit and full verification.

After each task, keep the tree compiling and its focused tests passing. Do not add
placeholder methods that throw `Not implemented` to satisfy types. If one session
cannot safely complete all tasks, stop only at a checkpoint with all preceding
tasks passing and report the first incomplete task precisely.

## Final Acceptance Criteria

- `.biodome/apps/*.mjs` and `.js` are loaded implicitly.
- Each file defines exactly one filename-named app.
- Missing apps directory preserves existing behavior.
- App recipes can be imported through normal npm resolution from
  `.biodome/node_modules`.
- Local app functions use the same scoped builder contract.
- Framework behavior is absent from Biodome core.
- App-contributed primitive names and working directories are scoped correctly.
- Cross-app references do not depend on alphabetical load order.
- Missing references and cycles fail before partial plan expansion.
- Expanded plans pass existing schema validation.
- Existing runtime drivers require no framework-specific code.
- Recipe provenance is visible through `biodome app inspect`.
- `.biodome/package.json` and lockfile are committed while its `node_modules` is
  ignored.
- Existing root package exports remain unchanged; `./app` is tested.
- Existing feature-only configurations remain valid.
- Documentation and a runnable example are included.

## Final Verification

Run:

```bash
npm run format
npm run check
npm run build
npm run test:integration
git diff --check
```

Also run the example CLI workflows against the built CLI:

```bash
node dist/cli/index.js --help
cd examples/apps-demo
node ../../dist/cli/index.js app validate
node ../../dist/cli/index.js app list
node ../../dist/cli/index.js app inspect api
node ../../dist/cli/index.js plan local smoke
```

## Completion Report

The implementing model must finish with:

```text
Plan: implicit apps and distributable app recipes
Status: complete | partial | blocked
Tasks completed: <numbers>
Files changed: <paths>
Behavior changed: <short factual list>
Tests added: <paths and cases>
Verification run: <commands and results>
Acceptance criteria not met: <none or exact items>
Follow-up discovered: <none or separate issue>
```
