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
  EnvSpecSchema,
  ServiceOptionsSchema,
  PlanSchema,
  VolumeSpecSchema,
  McpConfigSchema,
  RuntimeIdentitySchema,
  createPlan,
  identityForProcess,
  identitiesOf,
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
      command: ["npm", "test"],
      intent: "Review the code",
      outputs: ["review.md"],
      timeout: "20m",
      cleanup: "always",
    });
    expect(result.command).toEqual(["npm", "test"]);
    expect(result.intent).toBe("Review the code");
    expect(result.outputs).toEqual(["review.md"]);
    expect(result.timeout).toBe("20m");
    expect(result.cleanup).toBe("always");
  });

  it("applies defaults for optional fields", () => {
    const result = Schema.decodeSync(TaskSpecSchema)({
      command: ["npm", "test"],
      intent: "Fix bugs",
    });
    expect(result.command).toEqual(["npm", "test"]);
    expect(result.intent).toBe("Fix bugs");
    expect(result.outputs).toBeUndefined();
    expect(result.timeout).toBeUndefined();
    expect(result.cleanup).toBeUndefined();
  });

  it("rejects empty command", () => {
    expect(() => Schema.decodeSync(TaskSpecSchema)({ command: [], intent: "hi" })).toThrow();
  });

  it("rejects empty intent", () => {
    expect(() => Schema.decodeSync(TaskSpecSchema)({ command: ["true"], intent: "" })).toThrow();
  });

  it("rejects invalid cleanup value", () => {
    expect(() =>
      Schema.decodeSync(TaskSpecSchema)({
        command: ["true"],
        intent: "hi",
        cleanup: "invalid" as "always",
      }),
    ).toThrow();
  });

  it("rejects invalid duration", () => {
    expect(() =>
      Schema.decodeSync(TaskSpecSchema)({
        command: ["true"],
        intent: "hi",
        timeout: "not-a-duration",
      }),
    ).toThrow();
  });
});

describe("EnvSpecSchema", () => {
  it("requires exactly one value source", () => {
    expect(() => Schema.decodeSync(EnvSpecSchema)({})).toThrow();
    expect(() =>
      Schema.decodeSync(EnvSpecSchema)({ value: "x", from: { env: "TOKEN" } }),
    ).toThrow();
  });

  it("rejects build-scoped passthrough variables", () => {
    expect(() =>
      Schema.decodeSync(EnvSpecSchema)({ from: { env: "TOKEN" }, scope: "build" }),
    ).toThrow();
  });
});

describe("ServiceOptionsSchema credentials", () => {
  it("accepts literal and env-referenced user passwords", () => {
    const literal = Schema.decodeSync(ServiceOptionsSchema)({
      users: [{ name: "myapp", password: "devpassword" }],
    });
    expect(literal.users?.[0]?.password).toBe("devpassword");

    const referenced = Schema.decodeSync(ServiceOptionsSchema)({
      users: [{ name: "myapp", password: { env: "MY_PG_PASSWORD" } }],
    });
    expect(referenced.users?.[0]?.password).toEqual({ env: "MY_PG_PASSWORD" });
  });

  it("accepts a top-level password reference", () => {
    const decoded = Schema.decodeSync(ServiceOptionsSchema)({
      password: { env: "MY_PG_PASSWORD" },
    });
    expect(decoded.password).toEqual({ env: "MY_PG_PASSWORD" });
  });

  it("rejects malformed environment references", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServiceOptionsSchema)({
        users: [{ name: "myapp", password: { env: "" } }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ServiceOptionsSchema)({
        users: [{ name: "myapp", password: { env: "123_BAD" } }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ServiceOptionsSchema)({
        users: [{ name: "myapp", password: {} }],
      }),
    ).toThrow();
  });

  it("still requires a password on declared users", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServiceOptionsSchema)({ users: [{ name: "myapp" }] }),
    ).toThrow();
  });
});

describe("ServiceOptionsSchema extensions", () => {
  it("accepts supported Postgres extensions", () => {
    const decoded = Schema.decodeSync(ServiceOptionsSchema)({
      extensions: ["postgis", "pgcrypto"],
    });

    expect(decoded.extensions).toEqual(["postgis", "pgcrypto"]);
  });

  it("rejects unsupported and duplicate extensions", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServiceOptionsSchema)({ extensions: ["unknown"] }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ServiceOptionsSchema)({ extensions: ["postgis", "postgis"] }),
    ).toThrow();
  });
});

describe("VolumeSpecSchema", () => {
  const common = { name: "data", target: "/workspace/data" };

  it.each([
    { ...common, type: "local", source: "./data" },
    { ...common, type: "s3", bucket: "bucket" },
    { ...common, type: "gcs", bucket: "bucket" },
    { ...common, type: "azure", account: "account", container: "container" },
    { ...common, type: "sftp", host: "host", path: "/data" },
    { ...common, type: "smb", host: "host", share: "share" },
    { ...common, type: "webdav", url: "https://example.com" },
    { ...common, type: "dropbox", path: "/data" },
    { ...common, type: "gdrive", path: "/data" },
  ] as const)("validates a $type volume", (volume) => {
    expect(Schema.decodeSync(VolumeSpecSchema)(volume)).toMatchObject(volume);
  });

  it.each([
    { ...common, type: "local" },
    { ...common, type: "s3" },
    { ...common, type: "gcs" },
    { ...common, type: "azure", account: "account" },
    { ...common, type: "sftp", host: "host" },
    { ...common, type: "smb", host: "host" },
    { ...common, type: "webdav" },
    { ...common, type: "dropbox" },
    { ...common, type: "gdrive" },
  ] as Array<Record<string, unknown>>)(
    "rejects a $type volume without provider fields",
    (volume) => {
      expect(() => Schema.decodeUnknownSync(VolumeSpecSchema)(volume)).toThrow();
    },
  );
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

  it("rejects non-JSON-safe options", () => {
    expect(() =>
      Schema.decodeSync(RuntimeTargetSchema)({
        name: "test",
        driver: "docker-compose",
        options: { serialize: () => "invalid" },
      }),
    ).toThrow();
  });
});

describe("TaskSchema", () => {
  it("validates a stored task", () => {
    const result = Schema.decodeSync(TaskSchema)({
      name: "review-pr",
      command: ["npm", "test"],
      intent: "Review the PR",
      input: {},
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
        command: ["npm", "test"],
        intent: "Review",
        input: {},
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

describe("PlanSchema", () => {
  it("round-trips a complete representative plan", () => {
    const plan = createPlan("schema-test");
    plan.build.baseImage = "node:22-slim";
    plan.runtime.volumes.push({
      name: "data",
      type: "s3",
      target: "/workspace/data",
      bucket: "example-data",
    });
    plan.runtime.envVars.push({ key: "MODE", scope: "runtime", value: "test" });
    plan.deployment = {
      target: { name: "local", driver: "docker-compose", options: {} },
      deploymentId: "schema-test-local",
    };

    const decoded = Schema.decodeSync(PlanSchema)(JSON.parse(JSON.stringify(plan)));
    expect(decoded).toEqual(plan);
  });
});

describe("McpConfigSchema volume IO limits", () => {
  const decode = (limits: Record<string, unknown>) =>
    Schema.decodeUnknownSync(McpConfigSchema)({ enabled: false, ...limits });

  it("accepts finite positive integer limits", () => {
    expect(decode({ maxReadBytes: 1024, maxWriteBytes: 2048, maxListEntries: 50 })).toMatchObject({
      maxReadBytes: 1024,
      maxWriteBytes: 2048,
      maxListEntries: 50,
    });
  });

  it("rejects NaN, negative, fractional, and unbounded limits", () => {
    for (const key of ["maxReadBytes", "maxWriteBytes", "maxListEntries"]) {
      expect(() => decode({ [key]: Number.NaN })).toThrow();
      expect(() => decode({ [key]: -1 })).toThrow();
      expect(() => decode({ [key]: 1.5 })).toThrow();
      expect(() => decode({ [key]: 10485761 })).toThrow();
    }
  });

  it("accepts the documented maximum of 10 MiB", () => {
    expect(decode({ maxReadBytes: 10485760 })).toMatchObject({ maxReadBytes: 10485760 });
  });
});

describe("runtime identities", () => {
  it("defaults every plan to the runtime, mcp, and mount identities", () => {
    const plan = createPlan("my-app");
    expect(identitiesOf(plan).map((identity) => identity.role)).toEqual([
      "runtime",
      "mcp",
      "mount",
    ]);
    for (const identity of identitiesOf(plan)) {
      expect(identity.uid).toBeGreaterThan(0);
      expect(identity.gid).toBeGreaterThan(0);
    }
  });

  it("falls back to generated defaults for plans that predate identities", () => {
    const plan = createPlan("my-app");
    (plan.runtime as { identities?: unknown }).identities = undefined;
    expect(identitiesOf(plan)).toHaveLength(3);
  });

  it("resolves process identities with the runtime role as the default", () => {
    const plan = createPlan("my-app");
    const [runtime, mcp, mount] = identitiesOf(plan);
    const base = {
      command: ["node"],
      ports: [],
      environment: {},
      mode: "daemon" as const,
      startOn: "start.post" as const,
    };
    expect(identityForProcess(plan, { name: "web", ...base })).toEqual(runtime);
    expect(identityForProcess(plan, { name: "mcp", ...base, identity: "mcp" })).toEqual(mcp);
    expect(identityForProcess(plan, { name: "mount", ...base, identity: "mount" })).toEqual(mount);
  });

  it("validates identity names and id ranges", () => {
    expect(() =>
      Schema.decodeSync(RuntimeIdentitySchema)({
        role: "runtime",
        user: "Biodome",
        group: "biodome",
        uid: 10001,
        gid: 10001,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(RuntimeIdentitySchema)({
        role: "runtime",
        user: "biodome",
        group: "biodome",
        uid: 0,
        gid: 10001,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(RuntimeIdentitySchema)({
        role: "runtime",
        user: "biodome",
        group: "biodome",
        uid: 10001,
        gid: 65536,
      }),
    ).toThrow();
  });
});
