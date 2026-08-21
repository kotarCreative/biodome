import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolumeAccessError, type VolumeConfig } from "../../../mcp/volumes/adapter.js";
import { createLocalAdapter } from "../../../mcp/volumes/local.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function makeSource(): string {
  const source = mkdtempSync(join(tmpdir(), "biodome-local-volume-"));
  dirs.push(source);
  return source;
}

function adapterFor(source: string) {
  const config: VolumeConfig = { name: "files", type: "local", target: "/files", source };
  return createLocalAdapter(config);
}

describe("local volume adapter path guards", () => {
  it("reads and writes files inside the root (positive control)", async () => {
    const source = makeSource();
    writeFileSync(join(source, "inside.txt"), "hello");
    const adapter = adapterFor(source);

    await expect(adapter.read("inside.txt", { maxBytes: 1024 })).resolves.toEqual(
      Buffer.from("hello"),
    );
    await adapter.write("nested/new.txt", Buffer.from("written"));
    await expect(adapter.read("nested/new.txt", { maxBytes: 1024 })).resolves.toEqual(
      Buffer.from("written"),
    );
    await expect(adapter.stat(".")).resolves.toMatchObject({ isDirectory: true });
  });

  it("rejects absolute user paths on every operation", async () => {
    const source = makeSource();
    const adapter = adapterFor(source);
    const absolute = "/etc/passwd";

    await expect(adapter.list(absolute, { limit: 10 })).rejects.toThrow(VolumeAccessError);
    await expect(adapter.list(absolute, { limit: 10 })).rejects.toThrow(
      `Absolute paths are not allowed: ${absolute}`,
    );
    await expect(adapter.read(absolute, { maxBytes: 10 })).rejects.toThrow(
      "Absolute paths are not allowed",
    );
    await expect(adapter.write(absolute, Buffer.from("x"))).rejects.toThrow(
      "Absolute paths are not allowed",
    );
    await expect(adapter.stat(absolute)).rejects.toThrow("Absolute paths are not allowed");
  });

  it("rejects traversal outside the root", async () => {
    const adapter = adapterFor(makeSource());

    await expect(adapter.read("../sibling.txt", { maxBytes: 10 })).rejects.toThrow(
      "Path traversal detected: ../sibling.txt",
    );
    // Traversal hidden below a legitimate first segment.
    await expect(adapter.read("a/../../sibling.txt", { maxBytes: 10 })).rejects.toThrow(
      "Path traversal detected",
    );
    await expect(adapter.write("../escape.txt", Buffer.from("x"))).rejects.toThrow(
      "Path traversal detected",
    );
    await expect(adapter.stat("../sibling.txt")).rejects.toThrow("Path traversal detected");
  });

  it("rejects reading through a symlink that points outside the root", async () => {
    const source = makeSource();
    const outside = makeSource();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(source, "link"));
    const adapter = adapterFor(source);

    await expect(adapter.read("link/secret.txt", { maxBytes: 1024 })).rejects.toThrow(
      "Symlink escape detected: link/secret.txt",
    );
    await expect(adapter.stat("link/secret.txt")).rejects.toThrow("Symlink escape detected");
  });

  it("rejects listing through a directory symlink that points outside the root", async () => {
    const source = makeSource();
    const outside = makeSource();
    symlinkSync(outside, join(source, "dir-link"));
    const adapter = adapterFor(source);

    await expect(adapter.list("dir-link", { limit: 10 })).rejects.toThrow(
      "Symlink escape detected: dir-link",
    );
  });

  it("still reads a file reached via a symlink that stays inside the root", async () => {
    const source = makeSource();
    mkdirSync(join(source, "real"));
    writeFileSync(join(source, "real", "data.txt"), "ok");
    symlinkSync(join(source, "real"), join(source, "alias"));
    const adapter = adapterFor(source);

    await expect(adapter.read("alias/data.txt", { maxBytes: 1024 })).resolves.toEqual(
      Buffer.from("ok"),
    );
  });

  it("rejects writes whose parent components are symlinks", async () => {
    const source = makeSource();
    const outside = makeSource();
    symlinkSync(outside, join(source, "out-link"));
    const adapter = adapterFor(source);

    await expect(adapter.write("out-link/child.txt", Buffer.from("x"))).rejects.toThrow(
      "Symlink not allowed in write path: out-link/child.txt",
    );

    // A symlink deeper in the chain is rejected as well.
    mkdirSync(join(source, "a"));
    symlinkSync(join(source, "a"), join(source, "a-alias"));
    await expect(adapter.write("a-alias/b/c.txt", Buffer.from("x"))).rejects.toThrow(
      "Symlink not allowed in write path",
    );
  });

  it("allows writes into directories that do not exist yet", async () => {
    const source = makeSource();
    const adapter = adapterFor(source);

    await adapter.write("deep/er/file.txt", Buffer.from("created"));
    await expect(adapter.read("deep/er/file.txt", { maxBytes: 1024 })).resolves.toEqual(
      Buffer.from("created"),
    );
  });

  it("rejects reads exceeding the byte limit", async () => {
    const source = makeSource();
    writeFileSync(join(source, "big.txt"), "0123456789".repeat(10));
    const adapter = adapterFor(source);

    await expect(adapter.read("big.txt", { maxBytes: 10 })).rejects.toThrow(VolumeAccessError);
    await expect(adapter.read("big.txt", { maxBytes: 10 })).rejects.toThrow("exceeds read limit");
    await expect(adapter.read("big.txt", { maxBytes: 1000 })).resolves.toHaveLength(100);
  });
});
