// Structured event capture for sandbox operations.
// Every significant lifecycle step (plan, build, hook, runtime command, etc.)
// is emitted as a typed, append-only event so that a run can be replayed or
// audited later.

import { Effect, Context, Schema, Layer } from "effect";

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const EVENT_TYPES = [
  "run.started",
  "run.completed",
  "run.failed",
  "plan.loaded",
  "files.generated",
  "runtime.ensureAvailable",
  "hook.started",
  "hook.completed",
  "hook.failed",
  "runtime.build.started",
  "runtime.build.completed",
  "runtime.build.failed",
  "runtime.start.started",
  "runtime.start.completed",
  "runtime.start.failed",
  "runtime.stop.started",
  "runtime.stop.completed",
  "runtime.stop.failed",
  "runtime.exec.started",
  "runtime.exec.completed",
  "runtime.exec.failed",
  "runtime.restart.started",
  "runtime.restart.completed",
  "runtime.restart.failed",
  "runtime.logs.started",
  "runtime.logs.completed",
  "runtime.status.started",
  "runtime.status.completed",
  "runtime.status.failed",
  "service.start.started",
  "service.start.completed",
  "service.start.failed",
  "service.stop.started",
  "service.stop.completed",
  "service.stop.failed",
  "service.health_check",
  "config.validated",
  "task.started",
  "task.completed",
  "task.failed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EventTypeSchema = Schema.Literals(EVENT_TYPES);

export const SandboxEventSchema = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  sequence: Schema.Number,
  timestamp: Schema.String,
  type: EventTypeSchema,
  data: Schema.Unknown,
});

export type SandboxEvent = typeof SandboxEventSchema.Type;

export interface EventData {
  "run.started": { command: string; cwd: string };
  "run.completed": { command: string; durationMs: number };
  "run.failed": { command: string; durationMs: number; error: string };
  "plan.loaded": { project: string; languages: string[]; services: string[]; processes: string[] };
  "files.generated": { rootDir: string; files: string[] };
  "runtime.ensureAvailable": { backend: string };
  "hook.started": { name: string; point: string; command: string[]; location: "host" | "sandbox" };
  "hook.completed": { name: string; point: string; durationMs: number };
  "hook.failed": { name: string; point: string; durationMs: number; error: string };
  "runtime.build.started": { rootDir: string };
  "runtime.build.completed": { rootDir: string; durationMs: number };
  "runtime.build.failed": { rootDir: string; durationMs: number; error: string };
  "runtime.start.started": { rootDir: string; build: boolean };
  "runtime.start.completed": { rootDir: string; durationMs: number; build: boolean };
  "runtime.start.failed": { rootDir: string; durationMs: number; build: boolean; error: string };
  "runtime.stop.started": { rootDir?: string };
  "runtime.stop.completed": { rootDir?: string; durationMs: number };
  "runtime.stop.failed": { rootDir?: string; durationMs: number; error: string };
  "runtime.exec.started": { command: string[] };
  "runtime.exec.completed": { command: string[]; durationMs: number };
  "runtime.exec.failed": { command: string[]; durationMs: number; error: string };
  "runtime.restart.started": { processName: string };
  "runtime.restart.completed": { processName: string; durationMs: number };
  "runtime.restart.failed": { processName: string; durationMs: number; error: string };
  "runtime.logs.started": { processName?: string };
  "runtime.logs.completed": { processName?: string };
  "runtime.status.started": {};
  "runtime.status.completed": { durationMs: number };
  "runtime.status.failed": { durationMs: number; error: string };
  "service.start.started": { name: string };
  "service.start.completed": { name: string; state: string; health?: string };
  "service.start.failed": { name: string; exitCode?: number; error?: string };
  "service.stop.started": { name: string };
  "service.stop.completed": { name: string };
  "service.stop.failed": { name: string; error: string };
  "service.health_check": { name: string; status: string; failingStreak?: number };
  "config.validated": { project: string; valid: boolean };
  "task.started": { target: string; driver: string; task: string; harness: string };
  "task.completed": {
    target: string;
    driver: string;
    task: string;
    harness: string;
    durationMs: number;
    exitCode: number;
    artifacts?: Array<{ path: string; sizeBytes: number; localPath: string }>;
  };
  "task.failed": {
    target: string;
    driver: string;
    task: string;
    harness: string;
    durationMs: number;
    exitCode?: number;
    error: string;
  };
}

export interface EventStore {
  readonly runId: string;
  readonly emit: <T extends EventType>(
    type: T,
    data: EventData[T],
  ) => Effect.Effect<void, never, never>;
  readonly events: () => Effect.Effect<readonly SandboxEvent[]>;
  readonly close: () => Effect.Effect<void>;
}

export const EventStore = Context.Service<EventStore>("@biodome/EventStore");

const DEFAULT_MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB

export interface FileEventStoreOptions {
  readonly runId: string;
  readonly path: string;
  readonly clock?: () => Date;
  readonly maxSize?: number;
}

export function createFileEventStore(options: FileEventStoreOptions): EventStore {
  const runId = options.runId;
  const path = options.path;
  const now = options.clock ?? (() => new Date());
  const maxSize = options.maxSize ?? DEFAULT_MAX_LOG_SIZE;
  let sequence = 0;
  let closed = false;

  const ensureDir = () => {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  };

  const emit: EventStore["emit"] = (type, data) =>
    Effect.gen(function* () {
      if (closed) {
        throw new Error("EventStore is closed");
      }
      sequence += 1;
      const event: SandboxEvent = {
        id: randomUUID(),
        runId,
        sequence,
        timestamp: now().toISOString(),
        type,
        data,
      };
      ensureDir();
      // Avoid unbounded growth: skip write when max size is exceeded.
      if (maxSize > 0) {
        try {
          const stat = existsSync(path) ? readFileSync(path).length : 0;
          if (stat > maxSize) {
            yield* Effect.logWarning(
              `event log ${path} exceeds ${maxSize} bytes, dropping event ${type}`,
            );
            return;
          }
        } catch {
          // Best-effort size check; write anyway on error.
        }
      }
      appendFileSync(path, JSON.stringify(event) + "\n");
      yield* Effect.logInfo(`event:${type}`);
    });

  const events: EventStore["events"] = () =>
    Effect.sync(() => {
      if (!existsSync(path)) {
        return [];
      }
      const text = readFileSync(path, "utf-8");
      return text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SandboxEvent);
    });

  const close: EventStore["close"] = () =>
    Effect.sync(() => {
      closed = true;
    });

  return { runId, emit, events, close };
}

export const FileEventStoreLive = (options: FileEventStoreOptions): Layer.Layer<EventStore> =>
  Layer.succeed(EventStore, createFileEventStore(options));

export const NoOpEventStoreLive = (runId = "noop"): Layer.Layer<EventStore> =>
  Layer.succeed(EventStore, {
    runId,
    emit: () => Effect.void,
    events: () => Effect.succeed([]),
    close: () => Effect.void,
  });

export function eventLogPath(rootDir: string, runId: string): string {
  return join(rootDir, ".biodome-build", "logs", `events-${runId}.jsonl`);
}

export function formatEvent(event: SandboxEvent): string {
  const data =
    typeof event.data === "object" && event.data !== null
      ? JSON.stringify(event.data)
      : String(event.data);
  return `[${event.timestamp}] ${event.type.padEnd(32)} #${event.sequence} ${data}`;
}

export function filterEventsByRunId(
  events: readonly SandboxEvent[],
  runId: string,
): readonly SandboxEvent[] {
  return events.filter((e) => e.runId === runId);
}

export function readEventsFromPath(path: string): Effect.Effect<readonly SandboxEvent[]> {
  return Effect.sync(() => {
    if (!existsSync(path)) {
      return [];
    }
    const text = readFileSync(path, "utf-8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => Schema.decodeSync(SandboxEventSchema)(JSON.parse(line)));
  });
}
