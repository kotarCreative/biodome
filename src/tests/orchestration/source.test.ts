import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceRevision } from "../../orchestration/source.js";

describe("QA source provenance", () => {
  it("records HEAD and distinguishes tracked edits from untracked evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "biodome-provenance-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    try {
      git("init");
      writeFileSync(join(root, "app.txt"), "original\n");
      git("add", "app.txt");
      git(
        "-c",
        "user.name=QA",
        "-c",
        "user.email=qa@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "QA fixture",
      );
      const revision = git("rev-parse", "HEAD");
      expect(sourceRevision(root)).toEqual({ revision, trackedChanges: false, untrackedFiles: 0 });
      writeFileSync(join(root, "evidence.json"), "{}");
      expect(sourceRevision(root)).toEqual({ revision, trackedChanges: false, untrackedFiles: 1 });
      writeFileSync(join(root, "app.txt"), "changed\n");
      expect(sourceRevision(root)).toEqual({ revision, trackedChanges: true, untrackedFiles: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invent a revision outside Git", () => {
    const root = mkdtempSync(join(tmpdir(), "biodome-no-provenance-"));
    try {
      expect(sourceRevision(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
