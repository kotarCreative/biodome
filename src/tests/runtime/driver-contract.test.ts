import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { capabilitiesOf } from "../../core/capabilities.js";
import { createPlan } from "../../core/plan.js";
import { createAwsEcsDriver } from "../../runtime/aws-ecs.js";
import { dockerComposeDriver } from "../../runtime/docker-compose.js";
import {
  type ExecutableDriver,
  type RuntimeDriver,
  supportsExec,
  validateRuntimeDriver,
} from "../../runtime/driver.js";

describe("runtime driver contracts", () => {
  it("refines executable drivers only when declaration and method are both present", () => {
    const driver: RuntimeDriver & ExecutableDriver = {
      id: "exec",
      capabilities: capabilitiesOf("exec.command"),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    };
    const methodOnly = Object.assign(
      { id: "method-only", capabilities: capabilitiesOf() } satisfies RuntimeDriver,
      { exec: driver.exec },
    );

    expect(supportsExec(driver)).toBe(true);
    if (supportsExec(driver)) {
      const plan = createPlan("contract-test");
      expect(
        Effect.runSync(
          driver.exec({
            rootDir: "/project",
            outputDir: "/project/output",
            plan,
            target: { name: "local", driver: "exec", options: {} },
            deploymentId: "deployment",
            command: ["true"],
          }),
        ).exitCode,
      ).toBe(0);
    }
    expect(supportsExec(methodOnly)).toBe(false);
  });

  it("accepts the concrete Compose and ECS operation surfaces", () => {
    expect(() => validateRuntimeDriver(dockerComposeDriver)).not.toThrow();
    expect(() => validateRuntimeDriver(createAwsEcsDriver())).not.toThrow();
  });
});
