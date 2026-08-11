import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildPlan, buildTaskPlan } from "../../builder/index.js";
import { compileExecutionPlan } from "../../orchestration/compiler.js";
import { generateCompose } from "../../docker/generators/compose.js";

describe("app contract end to end", () => {
  const demo = join(process.cwd(), "examples", "apps-demo");

  it("expands implicit apps into ordinary primitives consumed by orchestration and compose", async () => {
    const plan = await buildPlan(demo);
    expect(plan.runtime.applications.map((app) => app.name)).toEqual(["api", "web"]);
    expect(plan.runtime.processes.map((process) => process.name)).toEqual(
      expect.arrayContaining(["api:web", "web:web"]),
    );
    expect(plan.runtime.endpoints.map((endpoint) => endpoint.name)).toEqual(
      expect.arrayContaining(["api:http", "web:http"]),
    );
    expect(plan.runtime.contributions.length).toBeGreaterThan(0);
    expect(generateCompose(plan)).toContain("3100:3100");
    const taskPlan = await buildTaskPlan(demo, "local", "smoke", { dryRun: true });
    expect(compileExecutionPlan(taskPlan).project).toBe("apps-demo");
  });
});
