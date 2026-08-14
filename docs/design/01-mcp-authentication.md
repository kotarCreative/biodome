# Plan 01: Enforce MCP Authentication

Status: complete. Priority: P0. Dependencies: none.

## Objective

Make authentication mandatory whenever the built-in MCP server is enabled, and
ensure every generated client either sends the credential correctly or fails during
plan validation.

## Current Baseline

- `McpOptions.token` is optional.
- `authenticateBearer()` authorizes every request when the resolved token is absent.
- Capability checks hide or reject disabled tools, but they are not an authentication
  boundary.
- Generated harness MCP configurations specify URLs without authenticated-client
  metadata.
- The MCP process receives only explicitly selected environment variables.

## Locked Decisions

- Enabling MCP requires an environment-backed token reference.
- Missing, empty, malformed, or incorrect credentials always fail closed.
- `/health` may remain unauthenticated only while it returns a constant response.
- Authorization remains separate from authentication. Authenticated callers still
  receive only enabled tools.
- Generated clients must use documented client support for HTTP headers. Do not place
  credentials in URLs or command arguments.
- If a harness cannot configure authenticated MCP requests, reject that MCP/harness
  combination before rendering. Do not add an unauthenticated bridge.
- The bearer token protects the HTTP boundary. It does not protect MCP from an agent
  process intentionally given the same token; Plan 04 addresses process identities.

## Files

- `src/core/plan.ts`
- `src/core/plan-builder/mcp.ts`
- `src/mcp/auth.ts`
- `src/mcp/startup.ts`
- `src/mcp/application.ts`
- `src/docker/generators/harnesses/`
- MCP, builder, generator, and contract tests under `src/tests/`

## Implementation Steps

1. Make the token required in MCP input types and schemas when `enabled` is true.
2. Reject literal tokens and missing environment references during plan construction.
3. Resolve the token once at MCP startup and fail startup if the referenced variable
   is absent or empty.
4. Change bearer authentication so an absent expected token never authorizes a
   request.
5. Keep `/health` constant and route every other request through authentication before
   MCP transport handling.
6. Add an authenticated-client descriptor to harness generation rather than
   duplicating header syntax across generators.
7. Implement that descriptor for each harness with documented header support.
8. Reject unsupported MCP/harness combinations with an actionable validation error.
9. Confirm disabled tools remain absent from discovery and rejected on direct calls.
10. Remove tests and documentation that treat `{ enabled: true }` without a token as
    valid.

## Required Tests

- Plan and builder tests reject missing, literal, and empty token references.
- Startup rejects an unset or empty referenced environment variable.
- HTTP contract tests cover missing, malformed, wrong, and correct bearer headers.
- `/health` returns only a constant body without authentication.
- Direct calls cannot bypass disabled tool authorization.
- Each supported harness generator includes an environment-backed authorization
  header and never includes the resolved token.
- Unsupported clients fail before generated files or runtime resources are created.

## Acceptance Criteria

- No enabled MCP plan can be built without an environment-backed token.
- `authenticateBearer(authorization, null)` cannot authorize a request.
- Generated files contain only the token reference, never its value.
- Every built-in harness is either proven to authenticate or explicitly rejected.
- Existing MCP HTTP contract tests pass for every runtime that exposes MCP.

## Verification

```bash
npm run test:run -- src/tests/contracts/mcp-http.contract.test.ts
npm run test:run -- src/tests/mcp src/tests/core/plan-builder/mcp.test.ts
npm run check
npm run build
npm run test:integration
```
