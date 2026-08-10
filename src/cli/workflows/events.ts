import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { formatEvent, type SandboxEvent } from "../../core/events.js";

const BUILD_DIR = ".biodome-build";

export function eventsWorkflow(rootDir: string, runId?: string) {
  return Effect.sync(() => {
    const buildDir = join(rootDir, BUILD_DIR);
    const logDirs: string[] = [join(buildDir, "logs")];
    const targetsDir = join(buildDir, "targets");
    if (existsSync(targetsDir)) {
      for (const entry of readdirSync(targetsDir)) {
        const targetLogs = join(targetsDir, entry, "logs");
        if (existsSync(targetLogs)) logDirs.push(targetLogs);
      }
    }
    const events: SandboxEvent[] = [];
    for (const logDir of logDirs) {
      if (!existsSync(logDir)) continue;
      for (const file of readdirSync(logDir).filter(
        (item) => item.startsWith("events-") && item.endsWith(".jsonl"),
      )) {
        for (const line of readFileSync(join(logDir, file), "utf-8")
          .split("\n")
          .filter((item) => item.trim().length > 0)) {
          events.push(JSON.parse(line) as SandboxEvent);
        }
      }
    }
    if (events.length === 0) return ["No events captured yet"];
    return (runId ? events.filter((event) => event.runId === runId) : events)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .map(formatEvent);
  });
}
