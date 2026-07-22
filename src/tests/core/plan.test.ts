import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import {
  validateTargetName,
  parseDuration,
  validateArtifactPath,
  isJsonSafeValue,
  validateJsonSafeOptions,
  TaskSpecSchema,
  RuntimeTargetSchema,
  TaskSchema,
  DeploymentPlanSchema,
} from "../../core/plan.js";

describe("validateTargetName", () => {
  it("accepts valid names", () => {
    expect(() => validateTargetName("local")).not.toThrow();
    expect(() => validateTargetName("staging")).not.toThrow();
    expect(() => validateTargetName("review-bot")).not.toThrow();
    expect(() => validateTargetName("aws.ecs")).not.toThrow();
    expect(() => validateTargetName("a1")).not.toThrow();
    expect(() => validateTargetName("my-target-v2")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateTargetName("")).toThrow();
  });

  it("rejects dot and dot-dot", () => {
    expect(() => validateTargetName(".")).toThrow();
    expect(() => validateTargetName("..")).toThrow();
  });

  it("rejects names with path separators", () => {
    expect(() => validateTargetName("a/b")).toThrow();
    expect(() => validateTargetName("../foo")).toThrow();
  });

  it("rejects names starting with non-alphanumeric", () => {
    expect(() => validateTargetName("-foo")).toThrow();
    expect(() => validateTargetName(".foo")).toThrow();
    expect(() => validateTargetName("_foo")).toThrow();
  });

  it("rejects names longer than 64 characters", () => {
    expect(() => validateTargetName("a".repeat(65))).toThrow();
    expect(() => validateTargetName("a".repeat(64))).not.toThrow();
  });

  it("rejects whitespace", () => {
    expect(() => validateTargetName("my target")).toThrow();
    expect(() => validateTargetName(" ")).toThrow();
  });
});

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("1s")).toBe(1);
  });

  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("1m")).toBe(60);
  });

  it("parses hours", () => {
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1h")).toBe(3600);
  });

  it("rejects invalid formats", () => {
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("5")).toThrow();
    expect(() => parseDuration("5x")).toThrow();
    expect(() => parseDuration("-1s")).toThrow();
    expect(() => parseDuration("0s")).toThrow();
  });
});

describe("validateArtifactPath", () => {
  it("accepts relative paths", () => {
    expect(() => validateArtifactPath("review.md")).not.toThrow();
    expect(() => validateArtifactPath("output/report.json")).not.toThrow();
    expect(() => validateArtifactPath("a/b/c.txt")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateArtifactPath("")).toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => validateArtifactPath("/etc/passwd")).toThrow();
    expect(() => validateArtifactPath("/workspace/review.md")).toThrow();
  });

  it("rejects traversal", () => {
    expect(() => validateArtifactPath("../secret")).toThrow();
    expect(() => validateArtifactPath("a/../../b")).toThrow();
  });

  it("rejects NUL byte", () => {
    expect(() => validateArtifactPath("bad\0file")).toThrow();
  });
});

describe("isJsonSafeValue", () => {
  it("accepts JSON-safe values", () => {
    expect(isJsonSafeValue(null)).toBe(true);
    expect(isJsonSafeValue("hello")).toBe(true);
    expect(isJsonSafeValue(42)).toBe(true);
    expect(isJsonSafeValue(true)).toBe(true);
    expect(isJsonSafeValue([1, 2, 3])).toBe(true);
    expect(isJsonSafeValue({ a: 1, b: "c" })).toBe(true);
    expect(isJsonSafeValue({ nested: { arr: [1, null, false] } })).toBe(true);
  });

  it("rejects non-JSON-safe values", () => {
    expect(isJsonSafeValue(undefined)).toBe(false);
    expect(isJsonSafeValue(Symbol("test"))).toBe(false);
    expect(isJsonSafeValue(() => 1)).toBe(false);
    expect(isJsonSafeValue(BigInt(1))).toBe(false);
  });

  it("rejects nested non-JSON values", () => {
    expect(isJsonSafeValue({ a: undefined })).toBe(false);
    expect(isJsonSafeValue([undefined])).toBe(false);
    expect(isJsonSafeValue({ a: { b: () => 1 } })).toBe(false);
  });
});

describe("validateJsonSafeOptions", () => {
  it("passes for valid JSON options", () => {
    expect(() => validateJsonSafeOptions({ region: "us-east-1", cpu: 1024 }, "opts")).not.toThrow();
  });

  it("throws for invalid options", () => {
    expect(() => validateJsonSafeOptions({ fn: () => 1 }, "opts")).toThrow();
  });
});

describe("TaskSpecSchema", () => {
  it("validates a complete spec", () => {
    const result = Schema.decodeSync(TaskSpecSchema)({
      harness: "codex",
      prompt: "Review the code",
      artifacts: ["review.md"],
      timeout: "20m",
      cleanup: "always",
    });
    expect(result.harness).toBe("codex");
    expect(result.prompt).toBe("Review the code");
    expect(result.artifacts).toEqual(["review.md"]);
    expect(result.timeout).toBe("20m");
    expect(result.cleanup).toBe("always");
  });

  it("applies defaults for optional fields", () => {
    const result = Schema.decodeSync(TaskSpecSchema)({
      harness: "claude",
      prompt: "Fix bugs",
    });
    expect(result.harness).toBe("claude");
    expect(result.prompt).toBe("Fix bugs");
    expect(result.artifacts).toBeUndefined();
    expect(result.timeout).toBeUndefined();
    expect(result.cleanup).toBeUndefined();
  });

  it("rejects empty harness", () => {
    expect(() => Schema.decodeSync(TaskSpecSchema)({ harness: "", prompt: "hi" })).toThrow();
  });

  it("rejects empty prompt", () => {
    expect(() => Schema.decodeSync(TaskSpecSchema)({ harness: "codex", prompt: "" })).toThrow();
  });

  it("rejects invalid cleanup value", () => {
    expect(() =>
      Schema.decodeSync(TaskSpecSchema)({
        harness: "codex",
        prompt: "hi",
        cleanup: "invalid" as "always",
      }),
    ).toThrow();
  });

  it("rejects invalid duration", () => {
    expect(() =>
      Schema.decodeSync(TaskSpecSchema)({
        harness: "codex",
        prompt: "hi",
        timeout: "not-a-duration",
      }),
    ).toThrow();
  });
});

describe("RuntimeTargetSchema", () => {
  it("validates a valid target", () => {
    const result = Schema.decodeSync(RuntimeTargetSchema)({
      name: "staging",
      driver: "docker-compose",
      options: {},
    });
    expect(result.name).toBe("staging");
    expect(result.driver).toBe("docker-compose");
  });

  it("rejects invalid target name", () => {
    expect(() =>
      Schema.decodeSync(RuntimeTargetSchema)({
        name: "../bad",
        driver: "docker-compose",
        options: {},
      }),
    ).toThrow();
  });

  it("rejects empty driver", () => {
    expect(() =>
      Schema.decodeSync(RuntimeTargetSchema)({
        name: "test",
        driver: "",
        options: {},
      }),
    ).toThrow();
  });
});

describe("TaskSchema", () => {
  it("validates a stored task", () => {
    const result = Schema.decodeSync(TaskSchema)({
      name: "review-pr",
      harness: "codex",
      prompt: "Review the PR",
      artifacts: ["review.md"],
      timeout: "20m",
      cleanup: "always",
    });
    expect(result.name).toBe("review-pr");
    expect(result.cleanup).toBe("always");
  });
});

describe("DeploymentPlanSchema", () => {
  it("validates with target only", () => {
    const result = Schema.decodeSync(DeploymentPlanSchema)({
      target: { name: "dev", driver: "docker-compose", options: {} },
      deploymentId: "my-project-dev-abc123",
    });
    expect(result.target.name).toBe("dev");
    expect(result.deploymentId).toBe("my-project-dev-abc123");
    expect(result.task).toBeUndefined();
  });

  it("validates with target and task", () => {
    const result = Schema.decodeSync(DeploymentPlanSchema)({
      target: { name: "dev", driver: "docker-compose", options: {} },
      task: {
        name: "review",
        harness: "claude",
        prompt: "Review",
        artifacts: [],
        timeout: "10m",
        cleanup: "on-success",
      },
      deploymentId: "my-project-dev-def456",
    });
    expect(result.task).toBeDefined();
    expect(result.task!.name).toBe("review");
  });
});
