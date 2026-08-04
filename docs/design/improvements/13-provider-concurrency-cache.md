# Plan 13: Bound Provider Concurrency and Cache Refresh

Status: proposed. Preserve provider tool names and execution semantics.

## Objective

Prevent one slow provider from blocking all catalog discovery and prevent concurrent callers from observing partial catalog state.

## Dependencies

- Prefer Plan 07 first so provider behavior is tested through injected dependencies.

## Files

- Modify `src/mcp/upstream.ts`.
- Extend `src/tests/mcp/upstream.test.ts`.
- Modify MCP application configuration for deadlines and concurrency.
- Update documentation for timeout behavior.

## Locked Decisions

- Provider tool execution is never retried automatically.
- Catalog refresh uses bounded concurrency.
- A refresh builds local results and atomically replaces the completed cache.
- Concurrent initial callers share one in-flight refresh.
- During later refreshes, callers may receive the previous completed cache.
- Provider errors must not include tokens or authorization headers.

## Required State

Replace the mutable partial cache with:

- completed catalog
- completed error list
- optional in-flight refresh promise
- connected-client promise per provider
- configurable connect and request deadlines

## Implementation Steps

1. Add injectable timeout and concurrency settings with safe defaults.
2. Change client connection caching to store one in-flight promise per provider.
3. Remove failed connection promises so a later request can retry.
4. Implement a deadline wrapper that aborts or closes timed-out connections where supported.
5. Fetch provider catalogs with bounded concurrency.
6. Collect entries and errors in local variables.
7. Sort entries deterministically by provider and tool.
8. Atomically assign completed cache and errors only after all bounded work settles.
9. Share one initial refresh promise across callers.
10. Keep `describe` consistent with completed cache and provider-specific fallback.
11. Apply request deadlines to `describe` and `call` without retrying calls.
12. Redact credential-bearing error text before storing or returning it.

## Required Tests

- Concurrent catalog calls perform one refresh.
- Callers never observe a partially filled catalog.
- Healthy providers return when another provider times out.
- Maximum active provider requests never exceeds configured concurrency.
- Output order is deterministic regardless of completion order.
- Failed connection can retry later.
- `provider_execute` is invoked once on timeout/failure.
- Errors do not contain test tokens or authorization values.

## Acceptance Criteria

- Catalog discovery latency is bounded by deadlines and concurrency batches.
- Cache replacement is atomic.
- Provider execution retains at-most-once client invocation behavior.
- Shutdown closes each created client once.

## Non-Goals

- Persistent provider catalogs.
- Automatic background refresh scheduling.
- Provider-specific retry policies.

## Verification

```bash
npm run check
npm run build
```
