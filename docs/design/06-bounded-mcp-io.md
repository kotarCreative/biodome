# Plan 06: Bound MCP I/O and Telemetry

Status: partial. Priority: P1. Dependencies: Plans 01 and 02.

## Objective

Ensure MCP commands, uploads, volume operations, upstream requests, and telemetry use
explicit time, byte, concurrency, and queue bounds without blocking unrelated
requests.

## Current Baseline

- Cloud volume adapters expose paginated list operations and bounded read helpers.
- Provider catalog refresh uses bounded concurrency, shared in-flight work, deadlines,
  and atomic completed-cache replacement.
- MCP plan loading and event writes use asynchronous filesystem APIs.
- Command execution has a timeout but relies on shell execution and incidental buffer
  behavior.
- Base64 writes are decoded before their byte limit is checked.
- Local directory listing reads and sorts the full directory.
- Adapter creation failures can remain cached and concrete clients may not close.
- Event write serialization uses unbounded promise chains.

## Locked Decisions

- One reusable command runner owns timeout, cancellation, output limits, and process
  tree termination.
- Shell interpretation remains available only behind explicit `allowExec`; prefer argv
  execution for internal commands.
- Request limits are checked before allocating decoded or buffered content whenever
  possible.
- Queues are bounded. Overflow drops telemetry with metrics rather than delaying the
  protected operation.
- Caches evict rejected initialization promises and expose deterministic cleanup.
- MCP transport/body limits complement tool-level limits; neither is sufficient alone.
- Existing paginated volume response shapes remain stable unless a versioned contract
  change is required.

## Files

- `src/mcp/application.ts`
- `src/mcp/server.ts`
- `src/mcp/event-sink.ts`
- `src/mcp/upstream.ts`
- `src/mcp/tools/process-logs.ts`
- `src/mcp/tools/volumes.ts`
- `src/mcp/volumes/adapter.ts`
- `src/mcp/volumes/local.ts`
- `src/mcp/volumes/s3.ts`
- `src/mcp/volumes/gcs.ts`
- `src/mcp/volumes/azure.ts`
- MCP and volume contract tests

## Implementation Steps

1. Define validated command timeout and stdout/stderr byte limits in MCP configuration.
2. Implement a `spawn`-based command runner with separate bounded streams, abort
   signals, timeout, and process-group termination.
3. Cancel command execution on request cancellation or client disconnect where the
   transport exposes a signal.
4. Return bounded error metadata without command text, output bodies, or secrets.
5. Add an HTTP request-body limit before MCP JSON/base64 parsing.
6. Reject base64 payloads whose encoded length cannot fit before decoding, then verify
   decoded length.
7. Replace local full-directory listing with bounded iteration or impose and validate
   a hard directory-entry ceiling.
8. Add a hard schema maximum for `maxListEntries` and clamp provider page requests.
9. Remove rejected adapter promises from the cache and implement `close()` for SDK
   clients that own resources.
10. Bind opaque cursors to adapter kind, volume identity, and path so they cannot be
    replayed against a different listing.
11. Replace promise-chain telemetry serialization with a bounded asynchronous queue,
    dropped-event counter, and explicit flush/close behavior.
12. Do not await best-effort telemetry writes on the MCP response critical path.
13. Propagate abort/deadline signals into upstream clients where supported and close
    timed-out connections deterministically.

## Required Tests

- Long-running and high-output commands are terminated at configured bounds.
- stdout and stderr are independently bounded and no child process remains after
  timeout or cancellation.
- A command cannot block `/health` or an unrelated status request.
- Oversized HTTP and base64 bodies fail before full decoded allocation.
- Local and cloud listings never exceed the configured page maximum.
- Rejected adapter creation retries; successful adapters are reused and closed once.
- Cursors cannot be replayed across volume/path boundaries.
- A full telemetry queue drops records, increments a counter, and does not delay the
  action response.
- Existing provider concurrency and cache tests remain deterministic.

## Acceptance Criteria

- Every MCP request path has explicit relevant time and byte bounds.
- No single command, upload, directory, provider, or telemetry burst can consume
  unbounded process memory.
- Cancellation and shutdown terminate owned subprocesses and clients.
- Telemetry cannot become backpressure on tool execution.

## Verification

```bash
npm run test:run -- src/tests/mcp
npm run test:run -- src/tests/contracts/volume-adapter.contract.test.ts
npm run check
npm run build
```
