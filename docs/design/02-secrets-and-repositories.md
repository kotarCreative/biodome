# Plan 02: Harden Secrets and Repository Sync

Status: proposed. Priority: P0. Dependencies: Plan 01.

## Objective

Ensure credential-bearing configuration is represented by typed references, never
returned by informational APIs or default events, and never persisted in generated
repository URLs or process arguments.

## Current Baseline

- Some credential APIs reject literal strings, while endpoints and volume adapters
  still permit them.
- LLM option validation infers sensitivity from selected property names.
- `get_sandbox_info` can expose connection information from the generated MCP plan.
- HTTPS repository tokens are interpolated into clone URLs.
- SSH repository sync uses trust-on-first-use rather than pinned known hosts.

## Locked Decisions

- Introduce a distinct `SecretReference` type for credentials. Do not use a union that
  also accepts literal strings on credential-bearing fields.
- Keep ordinary non-secret strings separate from secret fields in public schemas.
- Do not infer secrecy from names such as `key`, `token`, or `password` at runtime.
- Reject URL userinfo in user-supplied remote URLs. Authentication belongs in typed
  credential fields.
- Informational APIs return capability and reference metadata, not resolved values or
  password-bearing connection strings.
- HTTPS Git authentication uses an ephemeral askpass or credential-helper mechanism.
  Persisted remotes remain credential-free.
- SSH repositories require explicit pinned known-host material and strict checking.
- Redaction is defense in depth, not a substitute for typed secret handling.

## Files

- `src/core/feature.ts`
- `src/core/plan.ts`
- `src/core/plan-builder/providers.ts`
- `src/core/plan-builder/volumes.ts`
- `src/core/plan-builder/repositories.ts`
- `src/core/plan-builder/harnesses.ts`
- `src/core/info.ts`
- `src/mcp/generator.ts`
- `src/mcp/tools/info-provider.ts`
- `src/docker/generators/repositories.ts`
- Relevant plan, builder, MCP, and generator tests

## Implementation Steps

1. Inventory every credential field across MCP, endpoints, providers, volumes,
   repositories, services, harnesses, cloud targets, and free-form harness config.
2. Define `SecretReference` and schema helpers in one core module.
3. Migrate credential-bearing public fields to `SecretReference` and reject literals.
4. Replace heuristic LLM-option inspection with typed ordinary and secret option maps.
5. Reject embedded URL userinfo and document any explicitly supported signed-URL
   fields separately.
6. Redesign generated MCP information so service credentials and connection URLs are
   omitted or represented as redacted/reference metadata.
7. Ensure endpoint/provider information tools never resolve credentials for output.
8. Validate repository names before using them in paths, hook names, or shell scripts.
9. Add pinned known-host configuration for SSH repositories and generate
   `StrictHostKeyChecking=yes` with a dedicated `UserKnownHostsFile`.
10. Replace tokenized HTTPS clone URLs with an ephemeral askpass/helper flow, remove
    helper files after use, and preserve a credential-free `remote.origin.url`.
11. Add centralized structural redaction for errors and events that may contain
    provider responses or configuration fragments.
12. Write generated secret-bearing metadata with owner-only permissions.

## Required Tests

- Every credential-bearing schema rejects literal values and accepts environment
  references.
- URLs with userinfo and unsafe repository names are rejected.
- Serialized plans and generated artifacts contain references but no resolved values.
- MCP information responses contain no service password, token, or credential-bearing
  URL.
- HTTPS repository scripts contain no tokenized URL and leave a clean remote URL.
- SSH repositories without pinned known hosts are rejected.
- Generated SSH commands require strict checking and quote all paths and URLs.
- Error and event fixtures redact known secret values.

## Acceptance Criteria

- Repository search finds no public response path that resolves and returns a secret.
- Credential values cannot be supplied as literals through public configuration APIs.
- Git credentials do not appear in argv, generated scripts, event payloads, errors, or
  `.git/config`.
- SSH repository sync cannot silently trust an unknown host.
- Canonical plan contract tests cover every secret-reference shape.

## Verification

```bash
npm run test:run -- src/tests/contracts/plan-schema.contract.test.ts
npm run test:run -- src/tests/mcp src/tests/core/plan-builder
npm run test:run -- src/tests/docker/generators/repositories.test.ts
npm run check
npm run build
npm run test:integration
```
