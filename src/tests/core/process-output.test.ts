import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createFileEventStore, instrumentOperation, readEventFile } from "../../core/events.js";
import { createProcessOutput } from "../../core/process-output.js";
import { captureProcess } from "../../runtime/proc.js";

describe("live process event capture", () => {
  it("publishes framed output and validated reports before the command exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "biodome-live-output-"));
    let reported: () => void = () => {};
    const reportSeen = new Promise<void>((resolve) => {
      reported = resolve;
    });
    let completed = false;
    const path = join(dir, "events-live.jsonl");
    const store = createFileEventStore({
      runId: "live",
      path,
      onEvent: (event) => {
        if (event.type === "action.report") reported();
      },
    });
    try {
      const result = Effect.runPromise(
        instrumentOperation(
          store,
          { runId: "live" },
          "exec",
          { executable: "node", argumentCount: 2 },
          captureProcess({
            command: process.execPath,
            args: [
              "-e",
              `console.log('BIODOME_EVENT ' + JSON.stringify({type:'progress',message:'browser ready'})); setTimeout(() => { console.error('finished'); }, 400);`,
            ],
          }),
        ),
      ).then((value) => {
        completed = true;
        return value;
      });
      await reportSeen;
      expect(completed).toBe(false);
      expect(readEventFile(path).events.some((event) => event.type === "runtime.output")).toBe(
        true,
      );
      expect((await result).exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toContain("finished");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles split UTF-8 and secrets, rejects spoofed reports, and makes truncation explicit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "biodome-output-bounds-"));
    const path = join(dir, "events-bounds.jsonl");
    const store = createFileEventStore({ runId: "bounds", path });
    const output = createProcessOutput(store, { runId: "bounds" }, "exec", {
      limit: 256,
      secrets: ["private-value"],
    });
    try {
      await Effect.runPromise(output.write("stdout", Buffer.from("credential=private-")));
      await Effect.runPromise(output.write("stdout", Buffer.from("value\n")));
      const utf8 = Buffer.from("界\n");
      await Effect.runPromise(output.write("stdout", utf8.subarray(0, 1)));
      await Effect.runPromise(output.write("stdout", utf8.subarray(1)));
      await Effect.runPromise(
        output.write(
          "stdout",
          Buffer.from('BIODOME_EVENT {"type":"run.completed","message":"spoof"}\n'),
        ),
      );
      await Effect.runPromise(output.write("stderr", Buffer.from("x".repeat(20000))));
      await Effect.runPromise(output.end("stderr"));
      await Effect.runPromise(output.flush());
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("private-value");
      expect(text).toContain("REDACTED");
      expect(text).toContain("界");
      const events = readEventFile(path).events;
      expect(events.some((event) => event.type === "action.report.invalid")).toBe(true);
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
      expect(events.some((event) => event.type === "runtime.output.truncated")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a heartbeat for a quiet operation with increasing elapsed time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "biodome-heartbeat-"));
    const path = join(dir, "events-heartbeat.jsonl");
    const store = createFileEventStore({ runId: "heartbeat", path });
    try {
      await Effect.runPromise(
        instrumentOperation(
          store,
          { runId: "heartbeat" },
          "exec",
          { executable: "quiet", argumentCount: 0 },
          Effect.sleep("5200 millis"),
        ),
      );
      const heartbeat = readEventFile(path).events.find(
        (event) => event.type === "runtime.heartbeat",
      );
      expect(heartbeat?.data).toMatchObject({ operation: "exec", elapsedMs: expect.any(Number) });
      const data = heartbeat?.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("elapsedMs" in data) ||
        typeof data.elapsedMs !== "number"
      )
        throw new Error("Expected a timed heartbeat");
      expect(data.elapsedMs).toBeGreaterThanOrEqual(4900);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});
