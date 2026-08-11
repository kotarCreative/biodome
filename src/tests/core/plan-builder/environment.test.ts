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
});
