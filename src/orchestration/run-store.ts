import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { RuntimeError } from "../core/errors.js";
import type { RunRecord } from "./run-record.js";
import { runtimeLayout } from "../runtime/layout.js";

export function runRecordPath(rootDir: string, targetName: string, runId: string): string {
  return join(runtimeLayout(rootDir, targetName).host.logs, "runs", `${runId}.json`);
}

function runStoreError(operation: string, error: unknown): RuntimeError {
  return new RuntimeError({
    message: `Failed to ${operation} run record: ${error instanceof Error ? error.message : String(error)}`,
  });
}

export function writeRunRecordEffect(
  rootDir: string,
  record: RunRecord,
): Effect.Effect<string, RuntimeError> {
  return Effect.try({
    try: () => {
      const path = runRecordPath(rootDir, record.target, record.runId);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
      return path;
    },
    catch: (error) => runStoreError("write", error),
  });
}

export function readRunRecordEffect(
  rootDir: string,
  targetName: string,
  runId: string,
): Effect.Effect<RunRecord, RuntimeError> {
  return Effect.try({
    try: () => {
      const path = runRecordPath(rootDir, targetName, runId);
      if (!existsSync(path)) throw new Error(`Run record not found: ${runId}`);
      return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    },
    catch: (error) => runStoreError("read", error),
  });
}
