---
name: effect-ts
description: Use when writing, reviewing, or debugging TypeScript code with the Effect-TS library. Triggers on files importing from "effect", "@effect/*", or conversations about Effect, Layer, Schedule, Ref, Stream, or Fiber.
---

# Effect-TS

Guidelines for writing idiomatic, maintainable code with [Effect-TS](https://effect.website/).

## When to use

Use this skill whenever you are asked to:

- Write or refactor TypeScript code that uses `Effect`, `Layer`, `Schedule`, `Ref`, `Queue`, `Stream`, `Fiber`, or any `@effect/*` package.
- Debug runtime errors, type errors, or dead code in Effect-TS code.
- Convert callback/Promise code into Effect programs.
- Design services, dependency graphs, or resource management with Effect.

## Core philosophy

Effect-TS is not “async/await with extra steps.” It is a typed, composable, lazy effect system.

- **Lazy by default:** `Effect` values are descriptions of work. Nothing runs until you pass it to `Effect.runPromise`, `Effect.runSync`, or a runtime.
- **Errors are typed:** Every `Effect<A, E, R>` declares success type `A`, error type `E`, and required context `R`.
- **Context is explicit:** Dependencies are passed via `Layer` and consumed via `Effect.gen`/`Effect.provide`.
- **Composition over mutation:** Favor `pipe`, `Effect.gen`, and combinators over manual `Ref` updates or `Fiber` spawning.

## Setup and imports

Prefer the canonical `effect` package import. Avoid deep imports unless you need tree-shaking or a specific submodule.

```typescript
import { Effect, pipe, Layer, Option, Either, Schedule, Ref, Context, Exit } from "effect";
```

For platform-specific code (Node, HTTP, etc.):

```typescript
import { NodeRuntime } from "@effect/platform-node";
import { NodeContext } from "@effect/platform-node";
```

## Basic Effect construction

Use `Effect.sync` for synchronous side effects, `Effect.promise` for Promise-based work, and `Effect.try` for throwing functions.

```typescript
// Synchronous side effect
const now = Effect.sync(() => Date.now());

// Promise-based
const fetchUser = (id: string) =>
  Effect.promise(() => fetch(`/users/${id}`).then((r) => r.json()));

// Wrapping a throwing function
const parseJson = (input: string) =>
  Effect.try({
    try: () => JSON.parse(input),
    catch: (unknown) => new ParseError(`Invalid JSON: ${unknown}`),
  });
```

## Error handling

Model errors as plain classes. Extend `Schema.TaggedError` or use plain classes with a `readonly _tag`.

```typescript
class UserNotFound extends Schema.TaggedError<UserNotFound>("UserNotFound")(
  "UserNotFound",
  { userId: Schema.String }
) {}

class NetworkError extends Schema.TaggedError<NetworkError>("NetworkError")(
  "NetworkError",
  { message: Schema.String }
) {}
```

Use `Effect.catchTag`, `Effect.catchAll`, or `Effect.orDie` to handle errors at the right layer.

```typescript
const program = Effect.gen(function* () {
  const user = yield* fetchUser("123").pipe(
    Effect.catchTag("UserNotFound", () => Effect.succeed(null))
  );
  return user;
});
```

Never silently swallow errors. If an error should be impossible, use `Effect.orDie` or `Effect.catchAll((e) => Effect.logFatal(e).pipe(Effect.andThen(Effect.die(e))))`.

## Effect.gen over async/await

Use `Effect.gen` for sequential effectful code. Yielded values are typed correctly.

```typescript
const loadDashboard = Effect.gen(function* () {
  const db = yield* Database;
  const user = yield* db.getUser(userId);
  const orders = yield* db.getOrders(user.id);
  return { user, orders };
}).pipe(Effect.provide(DatabaseLive));
```

Inside `Effect.gen`, you can also use `yield* Effect.fail(error)` for early returns.

## Pipelines and combinators

For data transformation, prefer `pipe`.

```typescript
const result = pipe(
  Effect.succeed([1, 2, 3]),
  Effect.map((arr) => arr.map((n) => n * 2)),
  Effect.filterOrFail(
    (arr) => arr.length > 0,
    () => new EmptyError()
  ),
  Effect.tap((arr) => Effect.log(`Got ${arr.length} items`))
);
```

Common combinators:

- `Effect.map` — transform success values.
- `Effect.flatMap` — sequence dependent effects.
- `Effect.tap` — side effect without changing value.
- `Effect.filterOrFail` — assert on success.
- `Effect.zip` / `Effect.zipWith` — run independent effects in parallel.
- `Effect.all` — run a collection of effects.

## Dependency injection with Layer

Define services as `Context.Tag` interfaces and provide them with `Layer`.

```typescript
export class Database extends Context.Tag("Database")<
  Database,
  { readonly getUser: (id: string) => Effect.Effect<User, DbError>; readonly getOrders: (userId: string) => Effect.Effect<Order[]> }
>() {}

const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const pool = yield* acquirePool;
    return { getUser: (id) => pool.query(...), getOrders: (userId) => pool.query(...) };
  })
);
```

Build the dependency graph at the entry point:

```typescript
const program = loadDashboard.pipe(Effect.provide(DatabaseLive));

Effect.runPromise(program);
```

## Resource management

Use `Effect.acquireUseRelease` or `Scope` for resources that need cleanup.

```typescript
const withFile = (path: string) =>
  Effect.acquireUseRelease(
    Effect.promise(() => fs.open(path, "r")),
    (fd) => Effect.promise(() => fd.readFile({ encoding: "utf-8" })),
    (fd) => Effect.promise(() => fd.close())
  );
```

## Concurrency

Use `Effect.race`, `Effect.all({ concurrency: "inherit" })`, `Effect.fork`, and `Fiber.join` when you need concurrency. Avoid manual `Promise.all` inside `Effect.promise`.

```typescript
const parallel = Effect.all([fetchA, fetchB, fetchC], { concurrency: "inherit" });
```

Use `Ref` for shared mutable state, but prefer returning new values when possible.

```typescript
const counter = Ref.make(0);

const increment = Effect.gen(function* () {
  const ref = yield* counter;
  yield* Ref.update(ref, (n) => n + 1);
});
```

## Testing

Use `Effect.runPromise` or `Effect.runSync` in tests. Provide test layers.

```typescript
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

describe("user service", () => {
  it("returns a user", () =>
    Effect.runPromise(
      loadDashboard.pipe(
        Effect.provide(DatabaseTest),
        Effect.map((dashboard) => {
          expect(dashboard.user.id).toBe("123");
        })
      )
    );
  });
});
```

For assertions on errors, use `Effect.match` or `Effect.catchAll`.

```typescript
it("fails when user is missing", () =>
  Effect.runPromise(
    loadDashboard.pipe(
      Effect.provide(DatabaseEmpty),
      Effect.match({
        onFailure: (e) => expect(e._tag).toBe("UserNotFound"),
        onSuccess: () => expect.fail("should not succeed"),
      })
    )
  );
});
```

## Anti-patterns

- **Avoid `Effect.runPromise` inside effectful code.** Use `Effect.gen` and combinators.
- **Avoid mixing `Promise` and `Effect` arbitrarily.** If you must use a Promise, wrap it with `Effect.promise` and stay in Effect.
- **Avoid `any` or `unknown` for errors.** Define typed error classes.
- **Avoid global mutable state.** Pass state through `Ref`, `Layer`, or function arguments.
- **Avoid `Effect.runPromiseExit` unless you need to inspect `Exit` explicitly.** Prefer `Effect.runPromise` at the edge.

## Quick reference

| Goal | Use |
|------|-----|
| Sync side effect | `Effect.sync` |
| Promise | `Effect.promise` |
| Throwing function | `Effect.try` |
| Sequence | `Effect.gen` or `Effect.flatMap` |
| Transform | `Effect.map` / `pipe(..., Effect.map(...))` |
| Parallel | `Effect.all(..., { concurrency: "inherit" })` |
| Dependencies | `Context.Tag` + `Layer` + `Effect.provide` |
| Retry | `Effect.retry(policy)` with `Schedule` |
| Cache | `Effect.cached` |
| Resource cleanup | `Effect.acquireUseRelease` or `Scope` |

## References

- [Effect documentation](https://effect.website/docs/introduction)
- [Effect API reference](https://effect.website/docs/api)
- [Effect-TS GitHub](https://github.com/Effect-TS/effect)
