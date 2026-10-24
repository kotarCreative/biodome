# Test Ownership

Focused unit tests own implementation details and provider-specific behavior. Contract suites under `src/tests/contracts/` own shared observable boundaries and must be invoked by each built-in implementation.

- `lib/driver.ts`: runtime driver identity, capabilities, and public operation surface.
- `lib/plan.ts`: canonical plan encode/decode compatibility and secret references.
- `lib/mcp-http.ts`: listener health, authentication, and tool authorization over HTTP.
- `lib/volume-adapter.ts`: adapter list/read/write/stat/pagination/close semantics using a deterministic fake. Provider pagination remains in the provider tests.
- `src/tests/package/package.test.ts`: packed consumer import, bin, exports, and publish allowlist.
- `src/tests/integration/local-task-execution.test.ts`: generated named-target files execute in Docker.

The local execution fixture also owns regression coverage for base-image/host UID
collisions, non-root action execution, writable workspace/cache/home, restarting
an npm-managed server without orphaning its child, and command-only startup
readiness. These are runtime contracts, not application-specific exceptions.

Integration files run sequentially because CLI fixtures and package-consumer
checks rebuild the shared `dist/` tree. Running those files concurrently can
cause imports to see partially written builds; unit tests remain parallel.

Shutdown regressions assert that Docker stops both supervised and command-only
environments in under five seconds with its default ten-second stop timeout
unchanged, a normal exit code, and cleared readiness. A delayed application
SIGTERM handler must finish writing its shutdown marker before exit. Shell tests
also cover SIGINT and preserving startup failures while reaping managed children.

Startup contracts keep readiness independent of background monitor cadence:
health-monitor programs use `startsecs=0` because their scripts already sleep the
declared start period, and Compose uses a one-second `start_interval` while
starting. The steady-state probe interval still follows the declared process
health checks, so this does not add continuous per-second probing forever.
`start_interval` requires Docker Engine 25 or newer; older engines ignore or
reject the field, so keep the declared `interval` as the compatible fallback.
