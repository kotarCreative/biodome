# Plan 15: Add Contract-Focused Test Suites

Status: proposed. This supplements tests required by every implementation plan; it does not defer those tests.

## Objective

Test boundaries that multiple implementations must obey: package publishing, runtime drivers, schemas, generated layouts, and MCP transports.

## Dependencies

- Package contract depends on Plan 01.
- Layout contract depends on Plan 02.
- Schema contract depends on Plan 05.
- MCP contract depends on Plan 07.
- Driver contract is easiest after Plan 11.

## Files

- Add reusable helpers below `src/tests/contracts/` and `src/tests/lib/`.
- Modify integration configuration only when a contract requires Docker.
- Do not place production-only behavior in test helpers.

## Locked Decisions

- A contract suite is a function invoked for each implementation.
- Keep fast contracts in the normal unit suite.
- Keep Docker, real HTTP listeners, and cloud emulators in integration tests.
- Use fake cloud clients for deterministic SDK contracts unless a real service catches behavior a fake cannot.
- Contract assertions must describe behavior, not private method calls.

## Contract Suites

1. Package contract: packed import, bin execution, declared target existence, publish allowlist.
2. Driver metadata contract: ID, capabilities, method consistency, typed errors.
3. Driver lifecycle contract: operation ordering and result/state shape using fakes where possible.
4. Plan schema contract: decode, encode, round trip, secret-reference preservation.
5. Runtime layout contract: target containment and host/container correspondence.
6. Generated artifact contract: deterministic manifest, safe relative paths, executable modes.
7. MCP HTTP contract: health, authentication, authorization, error envelope, shutdown.
8. Volume adapter contract: allowed list/read/write/stat semantics, pagination, size errors, close behavior.

## Implementation Steps

1. Add a `contracts` test directory and document how implementations opt in.
2. Implement the package and layout contracts first because they have no external services.
3. Add schema round-trip fixtures containing every primitive family.
4. Add driver metadata contracts and invoke them for Docker Compose and ECS.
5. Add MCP HTTP contracts against an in-memory application and ephemeral listener.
6. Add a generic volume adapter fake contract, then provider-specific pagination tests outside the generic suite.
7. Add one named-target Docker integration proving generated paths execute, not merely render.
8. Ensure each contract failure names the implementation under test.
9. Document test ownership so behavior is not duplicated in many unit files.

## Required Tests

This plan is itself test work. Its acceptance criteria define the required coverage.

## Acceptance Criteria

- Every built-in driver runs the driver metadata contract.
- A representative complete plan round-trips through the canonical schema.
- MCP authentication and disabled-tool behavior run through a real HTTP boundary.
- The packed package is tested from outside the repository module graph.
- One integration test executes target-scoped generated runtime files.

## Non-Goals

- Pursuing a line-coverage percentage.
- Replacing focused unit tests with broad snapshots.
- Calling real LLM or SaaS providers in CI.

## Verification

```bash
npm run check
npm run build
npm run test:integration
```
