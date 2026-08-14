import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBuildManifest,
  directoryDigest,
  readBuildManifest,
  writeBuildManifest,
} from "../../runtime/build-manifest.js";

function manifest() {
  return createBuildManifest({
    target: "local",
    driver: "docker-compose",
    deploymentId: "deployment-1",
    digest: `sha256:${"a".repeat(64)}`,
    contentId: "content-1",
  });
}

describe("build manifests", () => {
  it("requires an immutable digest", () => {
    expect(() =>
      createBuildManifest({
        target: "local",
        driver: "docker-compose",
        deploymentId: "deployment-1",
        imageRef: "latest",
        contentId: "content-1",
      }),
    ).toThrow(/immutable content digest/);
  });

  it("persists atomically and validates identity on read", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "biodome-manifest-"));
    try {
      const value = manifest();
      writeBuildManifest(rootDir, "local", value);
      const path = join(rootDir, ".biodome-build", "targets", "local", "manifest.json");
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        digest: `sha256:${"a".repeat(64)}`,
      });
      expect(readBuildManifest(rootDir, "local", "deployment-1", "docker-compose")).toEqual(value);
      expect(() => readBuildManifest(rootDir, "local", "other", "docker-compose")).toThrow(
        /deployment ID mismatch/,
      );
      expect(() => readBuildManifest(rootDir, "local", "deployment-1", "aws-ecs")).toThrow(
        /driver mismatch/,
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects mutable or mismatched image identities", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(() =>
      createBuildManifest({
        target: "local",
        driver: "docker-compose",
        deploymentId: "deployment-1",
        digest: "latest",
        contentId: "content-1",
      }),
    ).toThrow(/SHA-256/);
    expect(() =>
      createBuildManifest({
        target: "local",
        driver: "docker-compose",
        deploymentId: "deployment-1",
        imageRef: "demo:latest",
        digest,
        contentId: "content-1",
      }),
    ).toThrow(/image reference/);
  });

  it("excludes manifests and mutable runtime output from content IDs", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "biodome-digest-"));
    try {
      writeFileSync(join(rootDir, "Dockerfile"), "FROM debian:12\n");
      const expected = directoryDigest(rootDir);
      writeFileSync(join(rootDir, "manifest.json"), "first manifest\n");
      writeFileSync(join(rootDir, "state.json"), "running\n");
      mkdirSync(join(rootDir, "artifacts"));
      writeFileSync(join(rootDir, "artifacts", "result.txt"), "result\n");
      mkdirSync(join(rootDir, "logs"));
      writeFileSync(join(rootDir, "logs", "runtime.log"), "log\n");

      expect(directoryDigest(rootDir)).toBe(expected);
      writeFileSync(join(rootDir, "Dockerfile"), "FROM debian:13\n");
      expect(directoryDigest(rootDir)).not.toBe(expected);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
