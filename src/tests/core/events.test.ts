import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  createFileEventStore,
  commandMetadata,
  instrumentOperation,
  NoOpEventStoreLive,
  readEventsFromPath,
  formatEvent,
  EventStore,
  type EventScope,
} from "../../core/events.js";
import { RuntimeError } from "../../core/errors.js";

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

  it("serializes concurrent emits into valid, increasing JSONL records", async () => {
    const path = join(dir, "events.jsonl");
    const store = createFileEventStore({ runId: "run-1", path });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Effect.runPromise(
          store.emit("run.completed", { command: String(index), durationMs: index }),
        ),
      ),
    );

    const events = await Effect.runPromise(readEventsFromPath(path));
    expect(events).toHaveLength(20);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
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

  it("retains only the newest eligible event files", async () => {
    const path = join(dir, "events-run-3.jsonl");
    writeFileSync(join(dir, "events-run-1.jsonl"), "{}\n");
    writeFileSync(join(dir, "events-run-2.jsonl"), "{}\n");
    const store = createFileEventStore({ runId: "run-3", path, maxFiles: 2 });

    await Effect.runPromise(store.emit("run.started", { command: "build", cwd: "/project" }));

    expect(existsSync(join(dir, "events-run-1.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "events-run-2.jsonl"))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("redacts secrets from event payloads before writing", async () => {
    const path = join(dir, "events.jsonl");
    const store = createFileEventStore({ runId: "run-1", path });

    await Effect.runPromise(
      store.emit("hook.failed", {
        name: "repo-sync",
        point: "start.pre",
        durationMs: 10,
        error: "clone failed: https://user:pass@example.com/repo.git",
      }),
    );

    const line = readFileSync(path, "utf-8").trim();
    expect(line).not.toContain("user:pass");
    expect(line).toContain("https://***REDACTED***@example.com/repo.git");
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

  it("keeps valid records when another line is malformed", async () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(
      path,
      '{"id":"id-1","runId":"run-1","sequence":1,"timestamp":"2026-01-01T00:00:00.000Z","type":"run.started","data":{}}\nnot json\n',
    );

    const events = await Effect.runPromise(readEventsFromPath(path));
    expect(events).toHaveLength(1);
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
      scope: { runId: "run-1" },
      data: { command: "build" },
    };
    expect(formatEvent(event)).toContain("run.started");
    expect(formatEvent(event)).toContain("2026-01-01T00:00:00.000Z");
    expect(formatEvent(event)).toContain("#1");
    expect(formatEvent(event)).toContain('{"command":"build"}');
  });
});

describe("instrumentOperation", () => {
  let dir: string;
  let path: string;
  const scope: EventScope = { runId: "run-1", target: "local", provider: "docker-compose" };

  beforeEach(() => {
    dir = tmpDir("events-instrument");
    path = join(dir, "events.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readAll() {
    return Effect.runPromise(readEventsFromPath(path));
  }

  function payload(event: Awaited<ReturnType<typeof readAll>>[number]): Record<string, unknown> {
    return event.data as Record<string, unknown>;
  }

  it("emits started and completed events carrying run, target, and provider scope", async () => {
    const store = createFileEventStore({ runId: scope.runId, path });
    await Effect.runPromise(
      instrumentOperation(store, scope, "build", { rootDir: "/project" }, Effect.succeed("image")),
    );

    const events = await readAll();
    expect(events.map((event) => event.type)).toEqual([
      "runtime.build.started",
      "runtime.build.completed",
    ]);
    for (const event of events) {
      expect(event.scope).toEqual(scope);
    }
    expect(payload(events[1])).toMatchObject({ rootDir: "/project" });
    expect(Number(payload(events[1]).durationMs)).toBeGreaterThanOrEqual(0);
  });

  it("emits a failed event with the error message when the operation fails", async () => {
    const store = createFileEventStore({ runId: scope.runId, path });
    const failure = instrumentOperation(
      store,
      scope,
      "start",
      { rootDir: "/project", build: false },
      Effect.fail(new RuntimeError({ message: "daemon refused" })),
    );
    await expect(Effect.runPromise(failure)).rejects.toBeInstanceOf(RuntimeError);

    const events = await readAll();
    expect(events.map((event) => event.type)).toEqual([
      "runtime.start.started",
      "runtime.start.failed",
    ]);
    expect(events[1].scope).toEqual(scope);
    expect(payload(events[1]).error).toBe("daemon refused");
  });

  it("persists command metadata without arguments, prompts, or output", async () => {
    const store = createFileEventStore({ runId: scope.runId, path });
    await Effect.runPromise(
      instrumentOperation(
        store,
        scope,
        "exec",
        commandMetadata(["npm", "test", "--secret-token"]),
        Effect.succeed({ exitCode: 0 }),
      ),
    );

    const events = await readAll();
    for (const event of events) {
      expect(event.scope).toEqual(scope);
      expect(payload(event).executable).toBe("npm");
      expect(JSON.stringify(event.data)).not.toContain("--secret-token");
    }
  });
});

describe("commandMetadata", () => {
  it("records only the executable name and argument count", () => {
    expect(commandMetadata(["npm", "test", "--silent"])).toEqual({
      executable: "npm",
      argumentCount: 2,
    });
    expect(commandMetadata([])).toEqual({ executable: "", argumentCount: 0 });
  });
});
