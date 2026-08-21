import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { RuntimeError } from "../../core/errors.js";
import {
  assertRelativeArtifactPath,
  collectArtifactsByCopying,
  supervisordLogFile,
  supervisorctlArgs,
} from "../../runtime/driver-kit.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("assertRelativeArtifactPath", () => {
  it("accepts relative workspace paths, including dot-prefixed names", () => {
    expect(() => assertRelativeArtifactPath("report.txt")).not.toThrow();
    expect(() => assertRelativeArtifactPath("logs/subdir/a..b.bin")).not.toThrow();
  });

  it("rejects absolute paths and traversal segments", () => {
    expect(() => assertRelativeArtifactPath("/etc/passwd")).toThrow(RuntimeError);
    expect(() => assertRelativeArtifactPath("../escape.txt")).toThrow(/traversal/);
    expect(() => assertRelativeArtifactPath("a/../../escape")).toThrow(/traversal/);
    expect(() => assertRelativeArtifactPath("..\\escape")).toThrow(/traversal/);
  });
});

describe("collectArtifactsByCopying", () => {
  const outputDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "biodome-driver-kit-"));
    dirs.push(dir);
    return dir;
  };

  it("copies each path into artifacts/<path> and reports collected sizes", async () => {
    const dir = outputDir();
    const collected: string[] = [];
    const artifacts = await Effect.runPromise(
      collectArtifactsByCopying({
        outputDir: dir,
        paths: ["a.txt", "nested/b.txt"],
        copy: (_path, localPath) =>
          Effect.sync(() => {
            writeFileSync(localPath, "x");
            collected.push(localPath);
            return "copied";
          }),
        describeMissing: (path) => `missing ${path}`,
      }),
    );

    expect(artifacts.map((artifact) => artifact.path)).toEqual(["a.txt", "nested/b.txt"]);
    expect(collected[0]).toBe(join(dir, "artifacts", "a.txt"));
    expect(collected[1]).toBe(join(dir, "artifacts", "nested", "b.txt"));
    expect(artifacts.every((artifact) => artifact.sizeBytes === 1)).toBe(true);
  });

  it("fails with the described error when a copy fails, leaving earlier artifacts intact", async () => {
    const dir = outputDir();
    const error = await Effect.runPromise(
      Effect.flip(
        collectArtifactsByCopying({
          outputDir: dir,
          paths: ["good.txt", "gone.txt"],
          copy: (path, localPath) =>
            path === "gone.txt"
              ? Effect.fail(new RuntimeError({ message: "cp" }))
              : Effect.sync(() => {
                  mkdirSync(localPath.replace(/\/[^/]+$/, ""), { recursive: true });
                  writeFileSync(localPath, "x");
                  return "ok";
                }),
          describeMissing: (path) => `Artifact "${path}" was not found`,
        }),
      ),
    );
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error.message).toBe('Artifact "gone.txt" was not found');
  });

  it("rejects invalid paths before attempting any copy", async () => {
    const dir = outputDir();
    let copies = 0;
    const error = await Effect.runPromise(
      Effect.flip(
        collectArtifactsByCopying({
          outputDir: dir,
          paths: ["../escape"],
          copy: () => {
            copies += 1;
            return Effect.succeed("ok");
          },
          describeMissing: (path) => path,
        }),
      ),
    );
    expect(error.message).toContain("traversal");
    expect(copies).toBe(0);
  });
});

describe("supervisord helpers", () => {
  it("resolves the per-process log file or the main log", () => {
    expect(supervisordLogFile("/var/log/app", "web")).toBe("/var/log/app/web.log");
    expect(supervisordLogFile("/var/log/app")).toBe("/var/log/app/supervisord.log");
    expect(() => supervisordLogFile("/var/log/app", "../evil")).toThrow(RuntimeError);
  });

  it("builds supervisorctl invocations for one or many processes", () => {
    expect(supervisorctlArgs("/etc/supervisor.conf", "restart", ["web"])).toEqual([
      "supervisorctl",
      "-c",
      "/etc/supervisor.conf",
      "restart",
      "web",
    ]);
    expect(supervisorctlArgs("/etc/supervisor.conf", "status", [])).toEqual([
      "supervisorctl",
      "-c",
      "/etc/supervisor.conf",
      "status",
    ]);
  });
});
