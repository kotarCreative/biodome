import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  matchesAllowedPath,
  decodeCursor,
  encodeCursor,
  type CursorScope,
} from "../../../mcp/volumes/adapter.js";
import { createLocalAdapter, MAX_DIRECTORY_SCAN_ENTRIES } from "../../../mcp/volumes/local.js";

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

describe("list cursors", () => {
  const scope: CursorScope = { kind: "local", volumeName: "files", path: "" };

  it("round-trips a token within its scope", () => {
    const cursor = encodeCursor("provider-token", scope);
    expect(cursor).toMatch(/^biodome:v2:/);
    expect(decodeCursor(cursor, scope)).toBe("provider-token");
  });

  it("keeps provider tokens opaque in the cursor string", () => {
    const cursor = encodeCursor("super-secret-provider-token", scope);
    expect(cursor).not.toContain("super-secret-provider-token");
  });

  it("rejects replay against another volume, path, or adapter kind", () => {
    const cursor = encodeCursor("provider-token", scope);
    expect(() => decodeCursor(cursor, { kind: "local", volumeName: "other", path: "" })).toThrow(
      "Invalid list cursor",
    );
    expect(() => decodeCursor(cursor, { kind: "local", volumeName: "files", path: "sub" })).toThrow(
      "Invalid list cursor",
    );
    expect(() => decodeCursor(cursor, { kind: "s3", volumeName: "files", path: "" })).toThrow(
      "Invalid list cursor",
    );
  });

  it("rejects tampered digests and legacy cursors", () => {
    const encoded = encodeCursor("provider-token", scope).slice("biodome:v2:".length);
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      token: string;
      digest: string;
    };
    const tampered =
      "biodome:v2:" +
      Buffer.from(JSON.stringify({ ...payload, digest: "AAAA" }), "utf8").toString("base64url");
    expect(() => decodeCursor(tampered, scope)).toThrow("Invalid list cursor");
    expect(() => decodeCursor("biodome:v1:dG9rZW4", scope)).toThrow("Invalid list cursor");
    expect(() => decodeCursor("not-a-cursor", scope)).toThrow("Invalid list cursor");
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
    expect(first.nextCursor).toMatch(/^biodome:v2:/);
    expect(second.files.map((file) => file.path)).toEqual(["z.txt"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("rejects a cursor issued for a different local volume", async () => {
    const sourceA = mkdtempSync(join(tmpdir(), "biodome-local-volume-"));
    const sourceB = mkdtempSync(join(tmpdir(), "biodome-local-volume-"));
    dirs.push(sourceA, sourceB);
    writeFileSync(join(sourceA, "a.txt"), "a");
    writeFileSync(join(sourceA, "c.txt"), "c");
    writeFileSync(join(sourceB, "b.txt"), "b");
    const first = createLocalAdapter({ name: "a", type: "local", target: "/a", source: sourceA });
    const second = createLocalAdapter({ name: "b", type: "local", target: "/b", source: sourceB });

    const page = await first.list("", { limit: 1 });
    expect(page.nextCursor).toBeDefined();

    await expect(second.list("", { limit: 1, cursor: page.nextCursor })).rejects.toThrow(
      "Invalid list cursor",
    );
  });

  it("rejects a cursor issued for a different path on the same volume", async () => {
    const source = mkdtempSync(join(tmpdir(), "biodome-local-volume-"));
    dirs.push(source);
    writeFileSync(join(source, "a.txt"), "a");
    mkdirSync(join(source, "sub"));
    writeFileSync(join(source, "sub", "b.txt"), "b");
    const adapter = createLocalAdapter({ name: "files", type: "local", target: "/files", source });

    const page = await adapter.list("", { limit: 1 });

    await expect(adapter.list("sub", { limit: 1, cursor: page.nextCursor })).rejects.toThrow(
      "Invalid list cursor",
    );
  });

  it("fails fast when a directory exceeds the hard scan ceiling", async () => {
    const source = mkdtempSync(join(tmpdir(), "biodome-local-volume-"));
    dirs.push(source);
    for (let index = 0; index <= MAX_DIRECTORY_SCAN_ENTRIES; index++) {
      writeFileSync(join(source, `f${String(index).padStart(6, "0")}.txt`), "x");
    }
    const adapter = createLocalAdapter({ name: "files", type: "local", target: "/files", source });

    await expect(adapter.list("", { limit: 10 })).rejects.toThrow(
      `exceeds the maximum of ${MAX_DIRECTORY_SCAN_ENTRIES} entries`,
    );
  }, 60_000);
});
