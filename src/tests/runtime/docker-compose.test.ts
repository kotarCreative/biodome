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
  it("uses Docker's immutable image ID directly", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(imageRefFromLocalDigest(digest)).toBe(digest);
  });

  it("rejects a mutable or malformed image ID", () => {
    expect(() => imageRefFromLocalDigest("latest")).toThrow(/invalid image digest/);
  });
});
