import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createPlan, type RuntimeTarget } from "../../core/plan.js";
import {
  buildDockerExecArgs,
  dockerComposeDriver,
  imageRefFromLocalDigest,
} from "../../runtime/docker-compose.js";
import { runtimeLayout } from "../../runtime/layout.js";

describe("buildDockerExecArgs", () => {
  it("preserves normal docker exec arguments", () => {
    expect(buildDockerExecArgs("test-deploy", ["echo", "hello"])).toEqual([
      "exec",
      "test-deploy-dev",
      "echo",
      "hello",
    ]);
  });

  it("enforces timed commands inside the container", () => {
    expect(buildDockerExecArgs("test-deploy", ["echo", "hello"], 1_500)).toEqual([
      "exec",
      "test-deploy-dev",
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "2s",
      "echo",
      "hello",
    ]);
  });
});

describe("imageRefFromLocalDigest", () => {
  it("uses Docker's immutable image ID directly", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(imageRefFromLocalDigest(digest)).toBe(digest);
  });

  it("rejects a mutable or malformed image ID", () => {
    expect(() => imageRefFromLocalDigest("latest")).toThrow(/invalid image digest/);
  });
});

describe("dockerComposeDriver.render", () => {
  it("creates the private log directory as the host user", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "biodome-compose-render-"));
    const target: RuntimeTarget = { name: "local", driver: "docker-compose", options: {} };
    const layout = runtimeLayout(rootDir, target.name);
    try {
      Effect.runSync(
        dockerComposeDriver.render({
          rootDir,
          outputDir: layout.host.root,
          plan: createPlan("test"),
          target,
        }),
      );

      const logs = statSync(layout.host.logs);
      expect(logs.isDirectory()).toBe(true);
      expect(logs.mode & 0o777).toBe(0o700);
      if (process.getuid) expect(logs.uid).toBe(process.getuid());
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
