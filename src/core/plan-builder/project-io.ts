import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectIO {
  fileExists(path: string): boolean;
  readFile(path: string): string;
  readJSON(path: string): unknown;
  exec(command: string): { stdout: string; stderr: string; exitCode: number };
}

export function createNodeProjectIO(rootDir: string): ProjectIO {
  return {
    fileExists: (path) => existsSync(join(rootDir, path)),
    readFile: (path) => readFileSync(join(rootDir, path), "utf-8"),
    readJSON(path) {
      return JSON.parse(this.readFile(path));
    },
    exec(command) {
      try {
        const stdout = execSync(command, {
          cwd: rootDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (error) {
        const err = error as Error & { stdout?: string; stderr?: string; status?: number };
        return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status || 1 };
      }
    },
  };
}
