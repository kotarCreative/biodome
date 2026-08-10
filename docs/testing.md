# Test Ownership

Focused unit tests own implementation details and provider-specific behavior. Contract suites under `src/tests/contracts/` own shared observable boundaries and must be invoked by each built-in implementation.

- `lib/driver.ts`: runtime driver identity, capabilities, and public operation surface.
- `lib/plan.ts`: canonical plan encode/decode compatibility and secret references.
- `lib/mcp-http.ts`: listener health, authentication, and tool authorization over HTTP.
- `lib/volume-adapter.ts`: adapter list/read/write/stat/pagination/close semantics using a deterministic fake. Provider pagination remains in the provider tests.
- `src/tests/package/package.test.ts`: packed consumer import, bin, exports, and publish allowlist.
- `src/tests/integration/local-task-execution.test.ts`: generated named-target files execute in Docker.
