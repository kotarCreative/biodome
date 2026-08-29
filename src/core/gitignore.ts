import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function ensureGitignoreEntries(rootDir: string, entries: readonly string[]): void {
  const path = join(rootDir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existingEntries = new Set(existing.split(/\r?\n/));
  const missing = entries.filter((entry) => !existingEntries.has(entry));
  if (missing.length === 0) return;

  const separator = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${separator}${missing.join("\n")}\n`);
}
