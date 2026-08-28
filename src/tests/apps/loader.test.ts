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
      expect.arrayContaining(["app-7-backend-web", "app-10-z-frontend-web"]),
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

    await expect(Effect.runPromise(loadAppsEffect(root, builder))).rejects.toThrow(
      'Application "z-invalid" requires unknown service "missing"',
    );

    builder.finalize();
    expect(builder.getPlan().runtime.services).toHaveLength(1);
    expect(builder.getPlan().runtime.processes.map((process) => process.name)).toEqual([
      "postgres-server",
      "postgres-init",
    ]);
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

    await expect(Effect.runPromise(loadAppsEffect(root, builder))).rejects.toThrow(
      'Application "z-invalid" references endpoint "a-valid.http", which is not declared',
    );

    builder.finalize();
    expect(builder.getPlan().runtime.applications).toEqual([]);
    expect(builder.getPlan().runtime.processes).toEqual([]);
  });

  it("does not let a colliding endpoint in another app satisfy a recipe reference", async () => {
    const root = project({
      ".biodome/config.json": JSON.stringify({ project: { name: "apps" } }),
      ".biodome/apps/consumer.mjs": `
        export default {
          _tag: "AppRecipe",
          id: "@test/collision-reference",
          apiVersion: 1,
          options: {
            target: { _tag: "AppEndpointReference", app: "foo", endpoint: "bar-baz" },
          },
          expand() {},
        };
      `,
      ".biodome/apps/foo.mjs": "export default function() {}",
      ".biodome/apps/foo-bar.mjs":
        'export default function(app) { app.exposeEndpoint("baz", { port: 4000 }); }',
    });

    await expect(buildPlan(root)).rejects.toThrow(
      'Application "consumer" references endpoint "foo.bar-baz", which is not declared',
    );
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
          qualifiedName: "app-3-api-web",
          source: expect.objectContaining({ recipe: "@test/api", recipeVersion: "1.2.3" }),
        }),
      ]),
    );
  });

  it("accepts shared recipe-option objects and arrays", async () => {
    const root = project({
      ".biodome/config.json": JSON.stringify({ project: { name: "apps" } }),
      ".biodome/apps/shared.mjs": `
        const object = { enabled: true };
        const array = ["value"];
        export default {
          _tag: "AppRecipe", id: "@test/shared", apiVersion: 1,
          options: { primary: object, fallback: object, first: array, second: array },
          expand() {},
        };
      `,
    });

    await expect(buildPlan(root)).resolves.toBeDefined();
  });

  it.each([
    ["a direct object cycle", "const options = {}; options.self = options;"],
    [
      "an indirect object-array cycle",
      "const options = {}; const array = [options]; options.array = array;",
    ],
  ])("rejects %s in recipe options", async (_name, setup) => {
    const root = project({
      ".biodome/config.json": JSON.stringify({ project: { name: "apps" } }),
      ".biodome/apps/cyclic.mjs": `
        ${setup}
        export default {
          _tag: "AppRecipe", id: "@test/cyclic", apiVersion: 1, options, expand() {},
        };
      `,
    });

    await expect(buildPlan(root)).rejects.toThrow("App recipe options must not contain cycles");
  });
});
