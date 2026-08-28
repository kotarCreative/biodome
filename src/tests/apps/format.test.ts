import { describe, expect, it } from "vitest";
import { createPlan } from "../../core/plan.js";
import { appInspection, formatAppList, formatAppInspection } from "../../apps/format.js";

describe("app formatting", () => {
  it("formats a stable summary and inspection", () => {
    const plan = createPlan("test");
    plan.runtime.applications.push({
      name: "api",
      root: "/workspace/apps/api",
      recipe: {
        id: "@test/api",
        version: "1.2.3",
        declarationPath: ".biodome/apps/api.mjs",
      },
      declarationPath: ".biodome/apps/api.mjs",
      repositories: ["api"],
      hooks: [],
      processes: ["app-3-api-web"],
      endpoints: ["app-3-api-http"],
      requiredServices: [],
      dependencies: [],
    });
    plan.runtime.contributions.push({
      kind: "process",
      qualifiedName: "app-3-api-web",
      source: {
        application: "api",
        recipe: "@test/api",
        recipeVersion: "1.2.3",
        declarationPath: ".biodome/apps/api.mjs",
        localName: "web",
      },
    });
    expect(formatAppList(plan)).toContain("@test/api@1.2.3");
    expect(formatAppInspection(plan, "api")).toContain("Recipe: @test/api@1.2.3");
    expect(appInspection(plan, "api").contributions).toHaveLength(1);
  });
});
