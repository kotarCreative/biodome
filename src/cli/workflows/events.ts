import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  DEFAULT_EVENT_QUERY_LIMIT,
  MAX_EVENT_QUERY_LIMIT,
  formatEvent,
  readEventFile,
  type EventQuery,
  type SandboxEvent,
} from "../../core/events.js";

const BUILD_DIR = ".biodome-build";

export function eventQuery(runId?: string, limit = DEFAULT_EVENT_QUERY_LIMIT): EventQuery {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_QUERY_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_EVENT_QUERY_LIMIT}`);
  }
  return { runId, limit };
}

function logDirectories(rootDir: string): readonly string[] {
  const buildDir = join(rootDir, BUILD_DIR);
  const dirs = [join(buildDir, "logs")];
  const targetsDir = join(buildDir, "targets");
  if (!existsSync(targetsDir)) return dirs;
  for (const entry of readdirSync(targetsDir)) dirs.push(join(targetsDir, entry, "logs"));
  return dirs;
}

function eventFiles(rootDir: string, query: EventQuery): readonly string[] {
  const dirs = logDirectories(rootDir).filter(existsSync);
  if (query.runId) {
    // A run ID maps directly to its file in each known log directory.
    const escapedRunId = query.runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matchingFile = new RegExp(`^events-${escapedRunId}\\.jsonl(?:\\.\\d+)?$`);
    return dirs
      .flatMap((dir) =>
        readdirSync(dir)
          .filter((file) => matchingFile.test(file))
          .map((file) => join(dir, file)),
      )
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  }
  return dirs
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => /^events-.+\.jsonl(?:\.\d+)?$/.test(file))
        .map((file) => join(dir, file)),
    )
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function eventsWorkflow(rootDir: string, query: EventQuery = eventQuery()) {
  return Effect.sync(() => {
    const events: SandboxEvent[] = [];
    const diagnostics: string[] = [];
    for (const path of eventFiles(rootDir, query)) {
      const result = readEventFile(path);
      diagnostics.push(
        ...result.diagnostics.map(
          (diagnostic) =>
            `Warning: malformed event in ${diagnostic.path}:${diagnostic.line}: ${diagnostic.message}`,
        ),
      );
      for (const event of result.events) {
        if ((!query.runId || event.runId === query.runId) && events.length < query.limit)
          events.push(event);
      }
      if (events.length >= query.limit) break;
    }
    if (events.length === 0 && diagnostics.length === 0) return ["No events captured yet"];
    return [
      ...events
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .map(formatEvent),
      ...diagnostics,
    ];
  });
}
