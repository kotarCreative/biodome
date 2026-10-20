import { describe, expect, it } from "vitest";
import { ApplicationBuilderImpl } from "../../apps/application-builder.js";
import { app } from "../../apps/references.js";
import type { ApplicationBuilder } from "../../apps/types.js";
import { PlanBuilder } from "../../core/plan-builder/plan-builder.js";
import { computerUse, type ComputerUseOptions } from "../../recipes/computer-use.js";

describe("computer-use recipe", () => {
  it("installs browser automation and records its target dependency", async () => {
    const plan = new PlanBuilder("/tmp/computer-use", "test");
    const web = new ApplicationBuilderImpl(plan.context, plan.applications, {
      name: "web",
      declarationPath: ".biodome/apps/web.mjs",
      knownApps: new Set(["qa", "web"]),
    });
    web.addProcess("web", { command: ["npm", "start"], port: 3000 });
    web.exposeEndpoint("http", { process: "web" });
    const recipe = computerUse({
      baseUrl: "http://localhost:3000",
      target: app("web").endpoint("http"),
      allowedDomains: ["localhost"],
      headed: true,
    });
    const builder = new ApplicationBuilderImpl(plan.context, plan.applications, {
      name: "qa",
      declarationPath: ".biodome/apps/qa.mjs",
      recipe: {
        id: recipe.id,
        version: recipe.version,
        declarationPath: ".biodome/apps/qa.mjs",
      },
      knownApps: new Set(["qa", "web"]),
    });

    await recipe.expand(builder, recipe.options);
    const application = builder.finish();
    plan.finalize();
    const result = plan.getPlan();

    expect(application.dependencies).toEqual(["app-3-web-http"]);
    const install = result.build.languageSnippets.join("\n");
    expect(install).toContain("agent-browser-linux-x64");
    expect(install).toContain("chromium");
    expect(install).toContain("ffmpeg");
    expect(install).toContain("xvfb-run");
    expect(result.runtime.environment).toMatchObject({
      BIODOME_QA_BASE_URL: "http://localhost:3000",
      BIODOME_QA_ARTIFACT_DIR: "/workspace/qa",
      AGENT_BROWSER_ALLOWED_DOMAINS: "localhost",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/local/bin/biodome-chromium",
      AGENT_BROWSER_HEADED: "1",
    });
  });

  it("validates URLs and navigation allowlists", () => {
    const invalidUrl = computerUse({ baseUrl: "localhost:3000" });
    const invalidDomain = computerUse({
      baseUrl: "http://localhost:3000",
      allowedDomains: ["localhost:3000"],
    });
    const invalidDomainList = computerUse({
      baseUrl: "http://localhost:3000",
      allowedDomains: "localhost",
    } as unknown as ComputerUseOptions);
    const invalidHeaded = computerUse({
      baseUrl: "http://localhost:3000",
      headed: "false",
    } as unknown as ComputerUseOptions);
    const missingBaseUrlHost = computerUse({
      baseUrl: "http://localhost:3000",
      allowedDomains: ["example.com"],
    });
    const invalidTarget = computerUse({
      baseUrl: "http://localhost:3000",
      target: "web",
    } as unknown as ComputerUseOptions);

    expect(() => invalidUrl.expand({} as ApplicationBuilder, invalidUrl.options)).toThrow(
      "baseUrl must use http or https",
    );
    expect(() => invalidDomain.expand({} as ApplicationBuilder, invalidDomain.options)).toThrow(
      "invalid allowed domain",
    );
    expect(() =>
      invalidDomainList.expand({} as ApplicationBuilder, invalidDomainList.options),
    ).toThrow("allowedDomains must be an array");
    expect(() => invalidHeaded.expand({} as ApplicationBuilder, invalidHeaded.options)).toThrow(
      "headed option must be a boolean",
    );
    expect(() =>
      missingBaseUrlHost.expand({} as ApplicationBuilder, missingBaseUrlHost.options),
    ).toThrow("allowedDomains must include the baseUrl host");
    expect(() => invalidTarget.expand({} as ApplicationBuilder, invalidTarget.options)).toThrow(
      "target must be an app endpoint reference",
    );
  });
});
