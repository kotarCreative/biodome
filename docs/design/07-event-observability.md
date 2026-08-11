# Plan 07: Finish Event Observability

Status: proposed. Priority: P1. Dependencies: Plans 03 and 06.

## Objective

Produce consistently scoped, redacted, bounded lifecycle events and make event queries
return the requested most-recent records without loading unrelated history.

## Current Baseline

- Event paths are scoped below each target output directory.
- Logs rotate at a size threshold and old files are pruned.
- The events CLI has bounded `--limit` and `--run` options and reports malformed
  records.
- Only selected task events carry target/provider metadata.
- Current runtime driver workflows omit some lifecycle events.
- Querying a recent file takes records from its beginning, so the default can return
  the oldest records from the newest run.
- Cross-run queries omit rotated files and selected files are read fully into memory.
- One event can exceed the configured file limit, and diagnostics are not bounded.

## Locked Decisions

- Use the common run/target/provider scope established by Plan 03.
- Lifecycle instrumentation belongs at orchestration/workflow boundaries, not in
  duplicated provider implementations.
- Default events contain metadata only. Prompt text, commands, arguments, tool input,
  tool output, hook stdin, artifact bodies, and secrets are excluded.
- Enforce a maximum encoded event size before queueing or writing.
- `--limit N` means the newest N matching events, printed chronologically.
- Rotated files are part of query history.
- Exact run lookup uses the target in the durable run record or an explicit `--target`;
  do not scan and parse every target log.
- CLI-only filesystem access may remain synchronous when bounded and materially
  simpler. Long-running event writers must use the bounded queue from Plan 06.

## Files

- `src/core/events.ts`
- `src/cli/program.ts`
- `src/cli/workflows/events.ts`
- `src/cli/workflows/target.ts`
- `src/orchestration/orchestrator.ts`
- `src/orchestration/run-store.ts`
- `src/runtime/layout.ts`
- Event, CLI workflow, and orchestration tests

## Implementation Steps

1. Apply the Plan 03 event scope to run, plan, hook, runtime, task, artifact, and
   cleanup events.
2. Centralize operation instrumentation so every built-in provider emits equivalent
   started/completed/failed lifecycle records.
3. Define safe metadata for each event type and remove command/prompt payload fields
   from defaults.
4. Apply structural redaction and a maximum encoded-event size before enqueueing.
5. Define deterministic behavior for oversized events: reject protected lifecycle
   events or emit a bounded truncation diagnostic without the payload.
6. Flush and close the bounded event queue during normal shutdown with a bounded
   deadline.
7. Update event-file discovery to include rotations and sort all candidates by actual
   recency.
8. Read recent records from file ends or stream through a fixed-size ring buffer so
   result memory is bounded by limit and event size.
9. Resolve `--run` through a target-aware run-record lookup. Add `--target` if no
   unambiguous global index exists.
10. Bound malformed-line diagnostics independently from event results.
11. Validate run records and events through their schemas before displaying them.
12. Update documentation only after the query semantics and payload defaults pass.

## Required Tests

- Every lifecycle event contains run, target, and provider scope.
- Default events exclude prompts, commands, arguments, outputs, artifact bodies, and
  injected secret fixtures.
- An oversized event cannot produce a file larger than the documented record policy.
- Rotation preserves complete JSONL records and owner-only modes.
- Default queries return the newest records from a file containing more than the
  limit.
- Cross-run queries include rotated files and produce globally correct ordering.
- `--run` with a known target does not read unrelated target logs.
- Query memory remains bounded for a large deterministic event fixture.
- Malformed diagnostics are reported with path/line and obey their own limit.

## Acceptance Criteria

- Lifecycle observability is equivalent across Compose, Docker Sandboxes, and ECS.
- Event payloads cannot disclose protected request or credential content by default.
- Storage and in-memory query usage have explicit limits.
- `biodome events --limit N` returns the newest N matches in chronological output
  order.
- Exact run queries do not parse unrelated historical logs.

## Verification

```bash
npm run test:run -- src/tests/core/events.test.ts
npm run test:run -- src/tests/cli/workflows/events.test.ts
npm run test:run -- src/tests/orchestration
npm run check
npm run build
```
