import fs from "node:fs/promises";
import path from "node:path";
import type { McpEventSink } from "./application.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROTATIONS = 5;

export function createFileMcpEventSink(
  filePath = process.env.MCP_EVENTS_LOG || "/workspace/.biodome-build/logs/mcp-events.jsonl",
): McpEventSink {
  let pending = Promise.resolve();
  const append = async (event: Readonly<Record<string, unknown>>) => {
    try {
      const directory = path.dirname(filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const line = JSON.stringify(event) + "\n";
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (stat && stat.size > 0 && stat.size + Buffer.byteLength(line) > MAX_BYTES) {
        await fs.rm(`${filePath}.${MAX_ROTATIONS}`, { force: true });
        for (let index = MAX_ROTATIONS - 1; index >= 1; index -= 1)
          await fs
            .rename(`${filePath}.${index}`, `${filePath}.${index + 1}`)
            .catch(() => undefined);
        await fs.rename(filePath, `${filePath}.1`);
      }
      await fs.appendFile(filePath, line, { mode: 0o600 });
      await fs.chmod(filePath, 0o600);
    } catch (error) {
      console.error(
        "[biodome-mcp] failed to write event log:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return {
    write(type, data) {
      pending = pending.then(() => append({ source: "mcp", type, ...data }));
      return pending;
    },
    async close() {
      await pending;
    },
  };
}
