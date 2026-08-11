import { describe, expect, it } from "vitest";
import { buildDockerExecArgs, imageRefFromLocalDigest } from "../../runtime/docker-compose.js";

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
  it("creates an immutable local image tag", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(imageRefFromLocalDigest("test-project", digest)).toBe(
      `test-project-dev:${"a".repeat(64)}`,
    );
  });

  it("rejects a mutable or malformed image ID", () => {
    expect(() => imageRefFromLocalDigest("test-project", "latest")).toThrow(/invalid image digest/);
  });
});
