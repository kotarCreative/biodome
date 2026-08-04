# Plan 09: Lazy-Load Runtime Drivers

Status: proposed. Keep this change limited to driver discovery and loading.

## Objective

Avoid loading AWS and other provider SDKs for commands that do not select those drivers.

## Current Problem

`src/runtime/registry.ts` statically imports Docker Compose and AWS ECS. Importing the registry therefore evaluates all AWS SDK modules even for `--help`, `info`, and local Docker commands.

## Dependencies

None. Complete before Plan 10 so CLI workflow tests use the final registry API.

## Files

- Modify `src/runtime/registry.ts`.
- Modify registry consumers in the builder and CLI.
- Add or extend `src/tests/runtime/registry.test.ts`.
- Modify `package.json` only if cloud dependencies become optional in a later isolated task.

## Locked Decisions

- Registry entries are asynchronous loader functions.
- Cache a successfully loaded driver.
- Cache one in-flight load promise so concurrent calls do not import twice.
- A failed load must not poison the cache permanently; a later call may retry.
- Unknown-driver errors list built-in IDs without loading their modules.
- Do not make cloud packages optional in the first implementation.

## Required Interface

```ts
type DriverLoader = () => Promise<RuntimeDriver>

registerDriver(id: string, loader: DriverLoader): void
getDriver(id: string): Effect.Effect<RuntimeDriver, RuntimeError>
```

The exact implementation may use `Effect.tryPromise`, but callers must continue receiving typed `RuntimeError` failures.

## Implementation Steps

1. Change registry storage from driver instances to loader records.
2. Register Docker Compose and AWS ECS with dynamic imports.
3. Validate that the loaded driver's `id` matches the registered key.
4. Add resolved-instance and in-flight-promise caches.
5. Map import failures to an error naming the selected driver without exposing secrets.
6. Update `getDriver` callers for the asynchronous Effect requirement.
7. Ensure `registeredDrivers` and `hasDriver` inspect registrations only.
8. Add a test-only registration helper or registry factory so tests do not mutate one process-global registry.
9. Measure `biodome --help` and registry import after a production build.

## Required Tests

- Looking up one driver invokes only its loader.
- Repeated and concurrent lookups share one successful load.
- Failed load can be retried.
- Loaded ID mismatch is rejected.
- Unknown driver lists IDs without invoking loaders.
- CLI `--help` succeeds when a cloud driver module is intentionally unavailable in a fixture.

## Acceptance Criteria

- `runtime/registry.ts` has no static imports of concrete drivers.
- Local CLI startup does not evaluate AWS driver modules.
- Registry errors remain typed and actionable.
- Existing target validation behavior remains unchanged.

## Non-Goals

- Plugin discovery from user directories.
- Third-party runtime driver packages.
- Optional peer dependencies in the same change.

## Verification

```bash
npm run check
npm run build
node dist/cli/index.js --help
```
