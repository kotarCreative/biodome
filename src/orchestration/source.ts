import { execFileSync } from "node:child_process";

export interface SourceRevision {
  revision: string;
  trackedChanges: boolean;
  untrackedFiles: number;
}

/** Metadata only: never checks out code or evaluates repository configuration. */
export function sourceRevision(rootDir: string): SourceRevision | undefined {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const revision = git(["rev-parse", "--verify", "HEAD"]);
    const status = git(["status", "--porcelain"]).split("\n").filter(Boolean);
    return {
      revision,
      trackedChanges: status.some((line) => !line.startsWith("??")),
      untrackedFiles: status.filter((line) => line.startsWith("??")).length,
    };
  } catch {
    return undefined;
  }
}
