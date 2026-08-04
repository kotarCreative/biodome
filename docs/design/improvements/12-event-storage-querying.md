# Plan 12: Improve Event Storage and Querying

Status: proposed. Coordinate with Task 11 in the security/performance plan.

## Objective

Keep event append cost independent of current log size and make event queries bounded, targeted, and resilient to malformed records.

## Dependencies

- If Plan 10 is complete, implement query behavior in its events workflow.
- Otherwise keep CLI changes small and move them during Plan 10 later.

## Files

- Modify `src/core/events.ts`.
- Modify `src/cli/index.ts` or `src/cli/workflows/events.ts`.
- Modify `src/tests/core/events.test.ts`.
- Add CLI event-query tests.
- Update event documentation.

## Locked Decisions

- Use file metadata or tracked bytes; never read the whole log to measure size before append.
- Serialize writes per event store.
- Rotate complete JSONL records before crossing the configured size.
- Default CLI queries are bounded.
- `--run` addresses matching run files directly instead of loading every run.
- Malformed records produce diagnostics and do not discard valid records from other lines.

## Implementation Steps

1. Replace `readFileSync(path).length` with initial `stat` and an in-memory byte count.
2. Update the byte count after each successful append and reset it after rotation.
3. Serialize concurrent emits with an Effect synchronization primitive or a private promise queue consistent with current repository patterns.
4. Define `EventQuery` with optional run ID and a required bounded limit after defaults.
5. Add `--limit <n>` with a conservative default and maximum.
6. For run-filtered queries, compute global and target candidate filenames directly.
7. For cross-run queries, inspect newest event files first and stop when enough valid events are collected.
8. Decode each line with `SandboxEventSchema` and attach filename/line diagnostics to failures.
9. Sort only the bounded selected result set.
10. Add retention by maximum file count per log directory if it is not already enforced.
11. Update documentation to describe rotation, limits, and malformed-line behavior.

## Required Tests

- Append does not call full-file read to obtain size.
- Concurrent emits retain unique increasing sequences and valid JSONL.
- Rotation preserves complete records and permissions.
- `--run` does not read unrelated files.
- Default and explicit limits are enforced.
- Malformed line reports filename and line while valid events still return.
- Retention removes only the oldest eligible files.

## Acceptance Criteria

- Event append is O(new event size), excluding occasional rotation work.
- CLI memory use is bounded by query limit plus one input file/stream buffer.
- Historical corruption does not crash `biodome events`.
- Permissions remain `0700` for directories and `0600` for files where supported.

## Non-Goals

- A database-backed event store.
- Event replay.
- Remote event upload.

## Verification

```bash
npm run check
npm run build
```
