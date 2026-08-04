import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  createFileEventStore,
  NoOpEventStoreLive,
  readEventsFromPath,
  formatEvent,
  filterEventsByRunId,
  EventStore,
} from "../../core/events.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

describe("createFileEventStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir("events-test");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes events to a JSONL file", async () => {
    const path = join(dir, "events.jsonl");
    const store = createFileEventStore({ runId: "run-1", path });

    await Effect.runPromise(store.emit("run.started", { command: "build", cwd: "/project" }));
    await Effect.runPromise(
      store.emit("plan.loaded", { project: "my-app", languages: [], services: [], processes: [] }),
    );
    await Effect.runPromise(store.emit("run.completed", { command: "build", durationMs: 100 }));

    const events = await Effect.runPromise(readEventsFromPath(path));
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("run.started");
    expect(events[0].runId).toBe("run-1");
    expect(events[0].sequence).toBe(1);
    expect(events[1].type).toBe("plan.loaded");
    expect(events[1].sequence).toBe(2);
    expect(events[2].type).toBe("run.completed");
    expect(events[2].sequence).toBe(3);
  });

  it("sequences events within a single run", async () => {
    const path = join(dir, "events.jsonl");
    const store = createFileEventStore({ runId: "run-1", path });

    await Effect.runPromise(store.emit("run.started", { command: "up", cwd: "/project" }));
    await Effect.runPromise(store.emit("run.completed", { command: "up", durationMs: 50 }));

    const events = await Effect.runPromise(readEventsFromPath(path));
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
  });

  it("returns events via the store API", async () => {
    const path = join(dir, "events.jsonl");
    const store = createFileEventStore({ runId: "run-1", path });

    await Effect.runPromise(store.emit("run.started", { command: "down", cwd: "/project" }));
    const events = await Effect.runPromise(store.events());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.started");
  });

  it("closes the store and prevents further emits", async () => {
    const path = join(dir, "events.jsonl");
    const store = createFileEventStore({ runId: "run-1", path });

    await Effect.runPromise(store.close());
    await expect(
      Effect.runPromise(store.emit("run.started", { command: "exec", cwd: "/project" })),
    ).rejects.toThrow("EventStore is closed");
  });

  it("rotates complete JSONL records and uses owner-only permissions", async () => {
    const path = join(dir, "events.jsonl");
    const store = createFileEventStore({ runId: "run-1", path, maxSize: 1 });

    await Effect.runPromise(store.emit("run.started", { command: "build", cwd: "/project" }));
    await Effect.runPromise(store.emit("run.completed", { command: "build", durationMs: 10 }));

    expect(JSON.parse(readFileSync(`${path}.1`, "utf-8"))).toMatchObject({ type: "run.started" });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({ type: "run.completed" });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("NoOpEventStoreLive", () => {
  it("does not write anything", async () => {
    const layer = NoOpEventStoreLive("noop-run");
    const program = Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.emit("run.started", { command: "test", cwd: "/project" });
      yield* store.emit("run.completed", { command: "test", durationMs: 10 });
      return yield* store.events();
    }).pipe(Effect.provide(layer));

    const events = await Effect.runPromise(program);
    expect(events).toHaveLength(0);
  });
});

describe("readEventsFromPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir("events-read");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty array when the file does not exist", async () => {
    const events = await Effect.runPromise(readEventsFromPath(join(dir, "missing.jsonl")));
    expect(events).toEqual([]);
  });

  it("decodes events against the schema", async () => {
    const path = join(dir, "events.jsonl");
    const store = createFileEventStore({ runId: "run-1", path });
    await Effect.runPromise(store.emit("config.validated", { project: "app", valid: true }));

    const events = await Effect.runPromise(readEventsFromPath(path));
    expect(events[0].type).toBe("config.validated");
    expect(events[0].data).toEqual({ project: "app", valid: true });
  });
});

describe("formatEvent", () => {
  it("renders the event type, timestamp, sequence, and data", () => {
    const event = {
      id: "id-1",
      runId: "run-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "run.started" as const,
      data: { command: "build" },
    };
    expect(formatEvent(event)).toContain("run.started");
    expect(formatEvent(event)).toContain("2026-01-01T00:00:00.000Z");
    expect(formatEvent(event)).toContain("#1");
    expect(formatEvent(event)).toContain('{"command":"build"}');
  });
});

describe("filterEventsByRunId", () => {
  it("keeps only events matching the run id", () => {
    const events = [
      {
        id: "a",
        runId: "run-1",
        sequence: 1,
        timestamp: "t",
        type: "run.started" as const,
        data: {},
      },
      {
        id: "b",
        runId: "run-2",
        sequence: 1,
        timestamp: "t",
        type: "run.started" as const,
        data: {},
      },
      {
        id: "c",
        runId: "run-1",
        sequence: 2,
        timestamp: "t",
        type: "run.completed" as const,
        data: {},
      },
    ];
    const filtered = filterEventsByRunId(events, "run-1");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.id)).toEqual(["a", "c"]);
  });
});
