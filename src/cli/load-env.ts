import { join } from "node:path";
import { readDotenv } from "../core/dotenv.js";
import { ensureGitignoreEntries } from "../core/gitignore.js";

/**
 * Load `.biodome/.env` into `process.env` so biodome commands can resolve
 * target option references without requiring the user to source the file first.
 * Existing environment values take precedence.
 */
export function loadBiodomeEnv(rootDir: string = process.cwd()): void {
  const path = join(rootDir, ".biodome", ".env");
  const file = readDotenv(path);
  for (const entry of file.entries) {
    if (process.env[entry.key] === undefined) {
      process.env[entry.key] = entry.value;
    }
  }
}

export function initializeCliEnvironment(rootDir: string = process.cwd()): void {
  ensureGitignoreEntries(rootDir, [".env"]);
  loadBiodomeEnv(rootDir);
}
