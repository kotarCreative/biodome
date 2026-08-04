import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunRecord } from "./run-record.js";
import { runtimeLayout } from "../runtime/layout.js";

export function runRecordPath(rootDir: string, targetName: string, runId: string): string {
  return join(runtimeLayout(rootDir, targetName).host.logs, "runs", `${runId}.json`);
}

export function writeRunRecord(rootDir: string, record: RunRecord): string {
  const path = runRecordPath(rootDir, record.target, record.runId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

export function readRunRecord(rootDir: string, targetName: string, runId: string): RunRecord {
  const path = runRecordPath(rootDir, targetName, runId);
  if (!existsSync(path)) throw new Error(`Run record not found: ${runId}`);
  return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
}
