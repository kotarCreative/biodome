import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventQuery, eventsWorkflow } from "../../../cli/workflows/events.js";

function event(runId: string, sequence: number, timestamp: string) {
  return JSON.stringify({
    id: `${runId}-${sequence}`,
    runId,
    sequence,
    timestamp,
    type: "run.started",
    data: {},
  });
}

describe("eventsWorkflow", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "events-workflow-"));
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it("uses direct run-file lookup without reading unrelated event files", () => {
    const logs = join(rootDir, ".biodome-build", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "events-run-1.jsonl"),
      `${event("run-1", 1, "2026-01-01T00:00:00.000Z")}\n`,
    );
    writeFileSync(join(logs, "events-run-2.jsonl"), "malformed unrelated record\n");

    const lines = Effect.runSync(eventsWorkflow(rootDir, eventQuery("run-1", 10)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("run.started");
  });

  it("enforces default and explicit query limits", () => {
    const logs = join(rootDir, ".biodome-build", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "events-run-1.jsonl"),
      `${event("run-1", 1, "2026-01-01T00:00:00.000Z")}\n${event("run-1", 2, "2026-01-02T00:00:00.000Z")}\n`,
    );

    const lines = Effect.runSync(eventsWorkflow(rootDir, eventQuery(undefined, 1)));
    expect(lines).toHaveLength(1);
    expect(eventQuery().limit).toBe(100);
    expect(() => eventQuery(undefined, 0)).toThrow("--limit");
  });

  it("reports malformed line locations while returning valid events", () => {
    const logs = join(rootDir, ".biodome-build", "logs");
    mkdirSync(logs, { recursive: true });
    const path = join(logs, "events-run-1.jsonl");
    writeFileSync(path, `${event("run-1", 1, "2026-01-01T00:00:00.000Z")}\nbad\n`);

    const lines = Effect.runSync(eventsWorkflow(rootDir, eventQuery(undefined, 10)));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("run.started");
    expect(lines[1]).toContain(`${path}:2`);
  });

  it("includes rotated segments when querying without a run id", () => {
    const logs = join(rootDir, ".biodome-build", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "events-run-1.jsonl"),
      `${event("run-1", 1, "2026-01-02T00:00:00.000Z")}\n`,
    );
    writeFileSync(
      join(logs, "events-run-1.jsonl.1"),
      `${event("run-1", 2, "2026-01-01T00:00:00.000Z")}\n`,
    );

    const lines = Effect.runSync(eventsWorkflow(rootDir, eventQuery(undefined, 10)));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("2026-01-01T00:00:00.000Z");
    expect(lines[1]).toContain("2026-01-02T00:00:00.000Z");
  });

  it("matches rotated segments when filtering by run id", () => {
    const logs = join(rootDir, ".biodome-build", "targets", "local", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "events-run-1.jsonl.2"),
      `${event("run-1", 1, "2026-01-01T00:00:00.000Z")}\n`,
    );

    const lines = Effect.runSync(eventsWorkflow(rootDir, eventQuery("run-1", 10)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("run.started");
  });
});
