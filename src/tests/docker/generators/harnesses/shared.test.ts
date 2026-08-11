import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { telemetryWriterModule } from "../../../../docker/generators/harnesses/shared.js";

describe("harness shared helpers", () => {
  it("writes shared telemetry records asynchronously with owner-only permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "biodome-telemetry-"));
    const writerPath = join(dir, "writer.cjs");
    const logPath = join(dir, "logs", "events.jsonl");

    try {
      writeFileSync(writerPath, telemetryWriterModule());
      const writer = createRequire(import.meta.url)(writerPath) as {
        write: (path: string, event: unknown) => Promise<void>;
      };
      await writer.write(logPath, { source: "test", type: "event", data: { value: 1 } });

      expect(JSON.parse(readFileSync(logPath, "utf-8"))).toEqual({
        source: "test",
        type: "event",
        data: { value: 1 },
      });
      expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
