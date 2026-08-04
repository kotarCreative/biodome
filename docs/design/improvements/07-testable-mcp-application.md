# Plan 07: Make the MCP Server Testable

Status: proposed. Implement before major MCP tool changes.

## Objective

Separate MCP domain behavior from process startup so authentication, tools, limits, logging, and shutdown can be tested without importing an executable with side effects.

## Dependencies

- Prefer Plan 02 first for consistent generated paths.

## Files

- Keep `src/mcp/server.ts` as the executable entry point.
- Add `src/mcp/application.ts`.
- Add `src/mcp/tools/` modules grouped by responsibility.
- Add `src/mcp/auth.ts` if authentication does not fit cleanly in the application module.
- Add `src/tests/mcp/server.test.ts` and focused tool tests.

## Locked Decisions

- Importing `application.ts` must not read files, inspect `process.argv`, bind a port, or register signals.
- The executable alone parses arguments, reads and decodes the plan, creates live dependencies, listens, and handles signals.
- Tool handlers receive explicit dependencies.
- Keep one MCP protocol server instance per application instance.
- Keep `/health` unauthenticated and constant; authenticate every transport request.
- Preserve disabled-by-default command execution and process control.

## Required Dependencies

Define interfaces for:

- `VolumeAdapterFactory`
- `ProviderRegistry`
- `ProcessRunner`
- `McpEventSink`
- clock/UUID generation where deterministic tests need them

Do not create interfaces for pure functions.

## Implementation Steps

1. Extract argument parsing into a pure function with tests.
2. Define and schema-decode the MCP plan input instead of using `any`.
3. Extract bearer authentication into a pure function.
4. Create `createMcpApplication(config, dependencies)` without startup side effects.
5. Move information and provider tools into one tool module.
6. Move process and log tools into one tool module.
7. Move volume tools into one tool module.
8. Replace the central switch with a map of tool name to typed handler.
9. Keep tool-list construction and handler registration driven by the same definitions so unavailable tools cannot be callable.
10. Return an application resource exposing the HTTP handler and `close()`.
11. Reduce `server.ts` to decode startup input, construct live dependencies, listen, and close resources on signals.
12. Ensure shutdown clears its forced-exit timer after graceful closure.

## Required Tests

- Missing, malformed, wrong, and correct bearer token tests.
- Constant unauthenticated `/health` response test.
- Disabled tools absent from list and rejected on direct call.
- Plan decode failure test.
- Process runner fake tests for logs, restart, and command execution.
- Volume adapter fake tests for list/read/write/stat routing.
- Graceful close test proving provider and adapter resources close.
- Listener host test for `127.0.0.1` in the executable wiring.

## Acceptance Criteria

- No test imports a module that starts a real server as a side effect.
- `src/mcp/server.ts` contains no tool business logic.
- MCP production code contains no `any` for plan, provider, tool, or request shapes.
- Every advertised tool has a focused handler test.

## Non-Goals

- Rewriting MCP code in Effect.
- Changing tool names or response formats.
- Adding pagination; that is Plan 08.

## Verification

```bash
npm run check
npm run build
```
