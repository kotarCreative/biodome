import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { matchesAllowedPath } from "../../../mcp/volumes/adapter.js";
import { createLocalAdapter } from "../../../mcp/volumes/local.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("matchesAllowedPath", () => {
  it("denies when no patterns are given", () => {
    expect(matchesAllowedPath("anything.txt", undefined)).toBe(false);
    expect(matchesAllowedPath("anything.txt", [])).toBe(false);
  });

  it("matches literal paths", () => {
    expect(matchesAllowedPath("reports/file.pdf", ["reports/file.pdf"])).toBe(true);
    expect(matchesAllowedPath("reports/file.txt", ["reports/file.pdf"])).toBe(false);
  });

  it("matches single-segment wildcards", () => {
    expect(matchesAllowedPath("reports/file.pdf", ["reports/*.pdf"])).toBe(true);
    expect(matchesAllowedPath("reports/file.txt", ["reports/*.pdf"])).toBe(false);
    expect(matchesAllowedPath("other/file.pdf", ["reports/*.pdf"])).toBe(false);
  });

  it("matches recursive wildcards", () => {
    expect(matchesAllowedPath("reports/2024/file.pdf", ["reports/**/*.pdf"])).toBe(true);
    expect(matchesAllowedPath("reports/file.pdf", ["reports/**/*.pdf"])).toBe(true);
    expect(matchesAllowedPath("reports/file.txt", ["reports/**/*.pdf"])).toBe(false);
  });

  it("matches any extension with **", () => {
    expect(matchesAllowedPath("data/nested/file.txt", ["data/**"])).toBe(true);
  });
});

describe("local volume adapter", () => {
  it("sorts and paginates bounded directory listings", async () => {
    const source = mkdtempSync(join(tmpdir(), "biodome-local-volume-"));
    dirs.push(source);
    writeFileSync(join(source, "z.txt"), "z");
    writeFileSync(join(source, "a.txt"), "a");
    writeFileSync(join(source, "m.txt"), "m");
    const adapter = createLocalAdapter({ name: "files", type: "local", target: "/files", source });

    const first = await adapter.list("", { limit: 2 });
    const second = await adapter.list("", { limit: 2, cursor: first.nextCursor });

    expect(first.files.map((file) => file.path)).toEqual(["a.txt", "m.txt"]);
    expect(first.nextCursor).toMatch(/^biodome:v1:/);
    expect(second.files.map((file) => file.path)).toEqual(["z.txt"]);
    expect(second.nextCursor).toBeUndefined();
  });
});
