import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGitignoreEntries } from "../../core/gitignore.js";

describe("ensureGitignoreEntries", () => {
  it("creates .gitignore and adds .env", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "gitignore-"));
    try {
      ensureGitignoreEntries(rootDir, [".env"]);
      expect(readFileSync(join(rootDir, ".gitignore"), "utf8")).toBe(".env\n");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("preserves existing rules and does not duplicate entries", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "gitignore-"));
    try {
      const path = join(rootDir, ".gitignore");
      writeFileSync(path, "node_modules\n.env\n");
      ensureGitignoreEntries(rootDir, [".env"]);
      expect(readFileSync(path, "utf8")).toBe("node_modules\n.env\n");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
