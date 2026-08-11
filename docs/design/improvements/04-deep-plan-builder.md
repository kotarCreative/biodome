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

## Providers Migration Contract

This section defines the providers pull request in the migration order. It covers
agent-discoverable endpoints, external/MCP providers, and LLM providers. It does
not cover runtime deployment drivers, provider SDK connections, MCP tool
execution, or harness normalization; those consume the normalized plan produced
by this domain.

### Module Boundary

- Add `src/core/plan-builder/providers.ts` with one `ProviderBuilder` that owns
  all rules for `addEndpoint`, `addProvider`, `addMcpProvider`,
  `addJiraProvider`, `addLinearProvider`, `addSentryProvider`,
  `addSlackProvider`, `addGithubProvider`, and `addLlmProvider`.
- The builder receives the private mutable plan and one injected
  `addEnv(key, spec)` capability. It must not import `EnvironmentBuilder`,
  `SandboxContext`, `node:fs`, or `node:child_process`.
- The providers module may expose an internal method that derives the MCP
  process environment from declared provider credential references. It returns
  a new `Record<string, string>` and must not expose the plan or a mutable
  provider array.
- `PlanBuilder` creates the domain builder. `SandboxContext` exposes the public
  primitive methods as bound closures only; it must contain no provider,
  endpoint, credential, or vendor-default validation.
- `configureMcp` remains the orchestration point that creates the MCP process.
  It asks the providers domain for provider credential environment entries and
  combines them with its own volume and MCP-token entries. The providers domain
  does not create a process or enable MCP.

### Normalized Plan Contract

- `addEndpoint` decodes `EndpointSpecSchema`, requires a port to be an integer
  from 1 through 65535, and rejects duplicate endpoint names. It writes only
  the endpoint fields defined in `Plan.runtime.endpoints`, shallow-copying
  `credentials` and `metadata` when present. Endpoint credentials continue to
  allow literal strings as well as `{ env: string }` references.
- `addProvider` decodes `ProviderSpecSchema`, rejects duplicate provider names,
  and writes only the normalized `Provider` fields to
  `Plan.runtime.providers`. It shallow-copies `credentials` and `metadata`.
  All provider credential values must be `{ env: "VAR" }` references; literal
  strings are rejected so they cannot reach `plan.json` or generated MCP
  configuration.
- `addMcpProvider` requires a non-empty name, `mcpUrl`, and
  `credentials.token`. It delegates through `addProvider` with
  `authCredential: "token"`, `authHeader: "Authorization"` unless overridden,
  and `authScheme: "Bearer "` unless overridden. The generic provider rule
  still rejects a literal token.
- Vendor helpers validate their required name and token before delegating to
  `addMcpProvider`. They preserve the caller's metadata and scope, use the
  standard authorization defaults, and set these defaults unless the caller
  supplies `mcpUrl`:

| Helper              | Type     | Default MCP URL                           | Scope mapping        |
| ------------------- | -------- | ----------------------------------------- | -------------------- |
| `addJiraProvider`   | `jira`   | `https://mcp.atlassian.com/v1/mcp/authv2` | `project -> project` |
| `addLinearProvider` | `linear` | `https://mcp.linear.app/mcp`              | `team -> project`    |
| `addSentryProvider` | `sentry` | `https://mcp.sentry.dev/mcp`              | none                 |
| `addSlackProvider`  | `slack`  | none; `mcpUrl` is required                | none                 |
| `addGithubProvider` | `github` | `https://api.githubcopilot.com/mcp/`      | none                 |

- `addLlmProvider` decodes `LlmProviderSpecSchema`, rejects duplicate LLM
  provider names, and normalizes absent `options` and `models` to independent
  empty records. The LLM-provider name registry is separate from external/MCP
  provider names.
- An LLM option whose case-insensitive key contains `key` may not hold a
  literal string; it must use an environment reference. Other supported option
  values retain their decoded value. Every environment-referenced option is
  declared through the injected `addEnv(value.env, { from: { env: value.env } })`
  capability so the harness can receive it at runtime. Preserve the current
  duplicate-environment behavior from the environment domain rather than adding
  local deduplication.

### Credential Handoff

- Declaring an external/MCP provider must not add credential values or
  passthrough declarations to the development service's global environment.
- When `configureMcp` runs, the providers domain contributes one
  `VAR: "${VAR}"` entry for every environment-referenced credential of every
  declared external provider. Literal values are impossible after validation.
- The MCP process keeps `mergeEnv: false`; provider credential references are
  available only to that process. This preserves the existing ordering: only
  providers declared before `configureMcp` are included in that process's
  generated environment.
- The provider and endpoint plan serialization consumed by `src/mcp/generator.ts`
  is unchanged. Environment references remain structural references in
  `plan.json`; no provider secret may be resolved while the plan is built.

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

### Providers Extraction Steps

1. Create `providers.test.ts` with the moved endpoint, external/MCP-provider,
   vendor-wrapper, and LLM-provider cases before moving implementation.
2. Add `ProviderBuilder` with only the injected `addEnv` capability and a
   focused internal MCP-credential-environment accessor.
3. Move endpoint normalization and generic provider validation first, retaining
   the existing plan shape and validation messages where tests assert them.
4. Move the generic MCP helper and vendor wrappers as one unit so all wrapper
   defaults remain centralized in the providers module.
5. Move LLM-provider normalization and its environment contribution; do not
   make harnesses own provider credential rules.
6. Replace the provider loop in `configureMcp` with the builder accessor while
   retaining volume and MCP-token handling there.
7. Bind the public `FeatureContext` methods to `ProviderBuilder`, delete the
   migrated imports and methods from `SandboxContext`, and keep the existing
   MCP plan serialization and Docker OpenCode-config tests unchanged.

## Required Tests

- One test file per domain module covering success, defaults, invalid input, duplicates, and derived contributions.
- A `ProjectIO` fake test for manifest detection and dry-run execution.
- Context integration test proving multiple primitive domains compose into one plan.
- Existing builder and generator tests unchanged unless expected normalized output intentionally changes.

### Providers Test Matrix

- Add `src/tests/core/plan-builder/providers.test.ts`. Construct the domain
  directly with `createPlan` and an `addEnv` spy/fake; it must not use
  `SandboxContext` or inspect a context-exposed plan.
- Endpoint cases: minimal declaration, port and metadata validation, duplicate
  names, literal and environment-reference credentials, and defensive copying
  of metadata and credentials.
- Generic provider cases: complete normalized declaration, schema failures,
  duplicate names, metadata validation, literal-credential rejection, and
  defensive copying.
- MCP cases: missing name, URL, or token; default and overridden auth fields;
  literal-token rejection through the generic path; credential environment
  derivation; and no eager global-environment contribution.
- Vendor cases: one table-driven success case for every helper, all documented
  defaults and scope mappings, Slack's required URL, missing-token rejection,
  and duplicate-name rejection across generic and vendor entry points.
- LLM cases: defaults, complete options and models, duplicate names, literal
  credential-like option rejection with case-insensitive keys, non-credential
  string acceptance, copied option/model records, and one `addEnv` call per
  environment-reference option. Include the environment-domain duplicate error
  as a propagated failure rather than implementing local deduplication.
- Keep one `PlanBuilder` integration test that declares an endpoint, an MCP
  provider, and an LLM provider through `FeatureContext`, configures MCP, and
  proves the final plan composes their independent contributions. Assert that
  the MCP process receives the provider credential reference with
  `mergeEnv: false`, while the LLM reference is declared through runtime env
  handling.
- Retain the existing `src/tests/mcp/generator.test.ts` serialization cases and
  `src/tests/docker/generator.test.ts` OpenCode LLM-provider rendering case as
  unchanged compatibility coverage.

## Acceptance Criteria

- `FeatureContext` exposes behavior, not mutable plan representation.
- No plan-builder domain imports `node:fs` or `node:child_process` directly.
- Each primitive's complete rules are located in one domain module.
- `SandboxContext` is removed or reduced to a small facade under 250 lines.
- All public primitive behavior remains covered by tests.
- `providers.ts` is the sole production location for endpoint, external/MCP,
  vendor-wrapper, and LLM-provider validation and normalization.
- Provider credential handoff to `configureMcp` is tested without exposing a
  mutable plan through `FeatureContext`.
- The providers migration does not change generated `plan.json`, MCP process
  credential isolation, or OpenCode LLM-provider configuration.

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
