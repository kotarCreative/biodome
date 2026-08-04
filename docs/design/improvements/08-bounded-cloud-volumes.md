# Plan 08: Bound and Paginate Cloud Volumes

Status: proposed. This plan changes the MCP volume response contract and must update documentation in the same change.

## Objective

Ensure list and read operations cannot fetch unbounded cloud data into memory, and expose provider continuation through an opaque cursor.

## Dependencies

- Complete Plan 07 first so tool behavior is independently testable.

## Files

- Modify `src/mcp/volumes/adapter.ts`.
- Modify `src/mcp/volumes/s3.ts`, `gcs.ts`, and `azure.ts`.
- Modify the MCP volume tool module created by Plan 07.
- Add provider-specific adapter tests.
- Update `docs/api.md` and volume examples.

## Locked Decisions

- `list` returns one page, never all pages.
- Cursors are opaque strings to MCP clients.
- The server clamps requested limits to configured `maxListEntries`.
- Read limits are bytes of decoded file content.
- Reject known-oversized objects before downloading.
- Stream unknown-size reads with a hard byte cap and abort when exceeded.
- Do not automatically retry writes.

## Required Interface

```ts
interface ListOptions {
  readonly limit: number;
  readonly cursor?: string;
}

interface FilePage {
  readonly files: readonly FileInfo[];
  readonly nextCursor?: string;
}

interface ReadOptions {
  readonly maxBytes: number;
}
```

Update `VolumeAdapter.list(path, options)` and `VolumeAdapter.read(path, options)` accordingly.

## Implementation Steps

1. Change adapter types and update test fakes before provider implementations.
2. Update MCP tool schemas to accept optional `limit` and `cursor` for listing.
3. Return JSON containing `files` and optional `nextCursor`; do not return newline-formatted file text.
4. Implement S3 `MaxKeys` and continuation token support.
5. Implement GCS `maxResults`, page token handling, and metadata reuse from listed file objects.
6. Implement Azure `.byPage({ continuationToken, maxPageSize })` handling.
7. Add a small cursor codec if provider cursors need namespacing. Validate malformed cursors as invalid parameters.
8. Use `stat` or response metadata before each read when available.
9. Bound streaming reads when metadata is missing or unreliable.
10. Validate base64 write size before decoding, then validate decoded bytes exactly.
11. Add an optional adapter `close` method and invoke it during MCP shutdown.
12. Update docs with pagination examples and size-limit errors.

## Required Tests

- First and second page tests for S3, GCS, and Azure.
- Requested limit is forwarded and clamped.
- Malformed cursor is rejected.
- Known oversized object is rejected before body download.
- Stream exceeding the limit aborts without returning partial content.
- Base64 write limits use decoded byte length.
- Repeated requests reuse one adapter; shutdown closes it once.

## Acceptance Criteria

- No cloud list implementation loops through every provider page.
- No cloud read path necessarily buffers content beyond `maxReadBytes`.
- MCP clients can traverse all pages with cursors.
- Existing allowed-path and read-only checks remain enforced before provider I/O.

## Non-Goals

- Recursive directory traversal.
- Cross-volume search.
- Streaming file content through MCP responses.

## Verification

```bash
npm run check
npm run build
```
