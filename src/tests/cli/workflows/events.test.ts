import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventQuery, eventsWorkflow, eventPageWorkflow } from "../../../cli/workflows/events.js";

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

  it("paginates rotated logs by sequence without skipping old events", () => {
    const logs = join(rootDir, ".biodome-build", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "events-page.jsonl.1"),
      event("page", 1, "2026-01-01T00:00:00Z") + "\n",
    );
    writeFileSync(
      join(logs, "events-page.jsonl"),
      event("page", 2, "2026-01-01T00:00:00Z") +
        "\n" +
        event("page", 3, "2026-01-01T00:00:00Z") +
        "\n",
    );
    const first = Effect.runSync(eventPageWorkflow(rootDir, "page", 0, 2));
    expect(first.events.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const second = Effect.runSync(eventPageWorkflow(rootDir, "page", first.nextSequence, 2));
    expect(second.events.map((entry) => entry.sequence)).toEqual([3]);
    expect(second.gap).toBe(false);
    expect(Effect.runSync(eventPageWorkflow(rootDir, "page", 0, 1)).firstAvailableSequence).toBe(1);
  });

  it("reports retention gaps and tolerates a partial live append", () => {
    const logs = join(rootDir, ".biodome-build", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "events-gap.jsonl"),
      event("gap", 10, "2026-01-01T00:00:00Z") + '\n{"partial":',
    );
    const page = Effect.runSync(eventPageWorkflow(rootDir, "gap", 3));
    expect(page.gap).toBe(true);
    expect(page.nextSequence).toBe(10);
    expect(page.diagnostics).toEqual([]);
  });
});
