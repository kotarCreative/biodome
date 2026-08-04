import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { buildPlan } from "../../builder/index.js";
import { loadAppsEffect } from "../../apps/loader.js";
import { PlanBuilder } from "../../core/plan-builder/plan-builder.js";

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "biodome-apps-"));
  dirs.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("implicit app loader", () => {
  it("discovers local apps before features and expands dependencies first", async () => {
    const root = project({
      ".biodome/config.json": JSON.stringify({ project: { name: "apps" } }),
      ".biodome/services.mjs": 'export default (ctx) => ctx.addService("postgres")',
      ".biodome/apps/z-frontend.mjs":
        'export const dependsOn = ["backend"]; export default function(app) { app.addProcess("web", { command: ["frontend"] }); app.exposeEndpoint("http", { process: "web" }); }',
      ".biodome/apps/backend.mjs":
        'export default function(app) { app.requireService("postgres"); app.addProcess("web", { command: ["backend"], port: 8000 }); app.exposeEndpoint("http", { process: "web" }); }',
      ".biodome/features/after.mjs":
        'export default function(ctx) { ctx.addLanguage("node", { version: "20" }); }',
    });
    const plan = await buildPlan(root);
    expect(plan.runtime.applications.map((entry) => entry.name)).toEqual(["backend", "z-frontend"]);
    expect(plan.runtime.processes.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["backend:web", "z-frontend:web"]),
    );
  });

  it("rejects mjs/js ambiguity before expansion", async () => {
    const root = project({
      ".biodome/config.json": JSON.stringify({ project: { name: "apps" } }),
      ".biodome/apps/api.mjs": "export default () => {}",
      ".biodome/apps/api.js": "export default () => {}",
    });
    await expect(buildPlan(root)).rejects.toThrow("Ambiguous app");
  });

  it("does not mutate the caller plan when an app requires an unknown service", async () => {
    const root = project({
      ".biodome/apps/a-valid.mjs":
        'export default function(app) { app.addProcess("web", { command: ["api"] }); }',
      ".biodome/apps/z-invalid.mjs":
        'export default function(app) { app.requireService("missing"); }',
    });
    const builder = new PlanBuilder(root, "apps");
    builder.context.addService("postgres");
    const before = structuredClone(builder.getPlan());

    await expect(Effect.runPromise(loadAppsEffect(root, builder))).rejects.toThrow(
      'Application "z-invalid" requires unknown service "missing"',
    );

    expect(builder.getPlan()).toEqual(before);
  });

  it("does not mutate the caller plan when a recipe references a missing endpoint", async () => {
    const root = project({
      ".biodome/apps/a-valid.mjs":
        'export default function(app) { app.addProcess("web", { command: ["api"] }); }',
      ".biodome/apps/z-invalid.mjs": `
        export default {
          _tag: "AppRecipe",
          id: "@test/missing-endpoint",
          apiVersion: 1,
          options: { target: { _tag: "AppEndpointReference", app: "a-valid", endpoint: "http" } },
          expand() {},
        };
      `,
    });
    const builder = new PlanBuilder(root, "apps");
    const before = structuredClone(builder.getPlan());

    await expect(Effect.runPromise(loadAppsEffect(root, builder))).rejects.toThrow(
      'Application "z-invalid" references endpoint "a-valid.http", which is not declared',
    );

    expect(builder.getPlan()).toEqual(before);
  });

  it("records recipe versions in application metadata and contribution provenance", async () => {
    const root = project({
      ".biodome/config.json": JSON.stringify({ project: { name: "apps" } }),
      ".biodome/apps/api.mjs": `
        export default {
          _tag: "AppRecipe",
          id: "@test/api",
          version: "1.2.3",
          apiVersion: 1,
          options: {},
          expand(app) {
            app.addProcess("web", { command: ["api"], port: 3000 });
            app.exposeEndpoint("http", { process: "web" });
          },
        };
      `,
    });

    const plan = await buildPlan(root);
    expect(plan.runtime.applications[0]?.recipe).toEqual({
      id: "@test/api",
      version: "1.2.3",
      declarationPath: ".biodome/apps/api.mjs",
    });
    expect(plan.runtime.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qualifiedName: "api:web",
          source: expect.objectContaining({ recipe: "@test/api", recipeVersion: "1.2.3" }),
        }),
      ]),
    );
  });
});
