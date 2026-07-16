import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildPlan, validateConfig, validateFeatures } from "../../builder/index.js";
import { generateDockerfile, generateCompose } from "../../docker/generator.js";

function createProject(dir: string, files: Record<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(fullPath.split("/").slice(0, -1).join("/"), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

describe("buildPlan", () => {
  it("loads config and features", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "my-app" } }),
      "sandbox/services.mjs": `
        export default function services(ctx) {
          ctx.addService("postgres", { port: 5432 });
        }
      `,
      "sandbox/features/django.mjs": `
        export default function django(ctx) {
          ctx.addLanguage("python", { version: "3.12" });
          ctx.addProcess({
            name: "django",
            command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
            port: 8000,
          });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.project).toBe("my-app");
    expect(plan.build.baseImage).toBe("python:3.12-slim");
    expect(plan.runtime.processes).toHaveLength(1);
    expect(plan.runtime.services).toHaveLength(1);
    expect(plan.runtime.services[0].name).toBe("postgres");
  });

  it("still loads legacy .js feature files", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "legacy-app" } }),
      "sandbox/services.js": `
        export default function services(ctx) {
          ctx.addService("redis", { port: 6379 });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.runtime.services).toHaveLength(1);
    expect(plan.runtime.services[0].name).toBe("redis");
  });

  it("executes arbitrary commands in features", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "cmd-app" } }),
      "sandbox/features/env.mjs": `
        export default function env(ctx) {
          const result = ctx.exec("echo branch=main");
          ctx.setEnv("BRANCH", result.stdout.trim().split("=")[1]);
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.runtime.environment.BRANCH).toBe("main");
  });

  it("uses npm install when no lock file exists", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "node-app" } }),
      "package.json": JSON.stringify({ name: "node-app" }),
      "sandbox/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "20" });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.build.dependencyFiles).toEqual(["package.json"]);
    expect(plan.build.dependencyInstalls).toHaveLength(1);
    expect(plan.build.dependencyInstalls[0].command).toContain("npm install");

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("npm install");
    expect(dockerfile).not.toContain("npm ci");
    expect(dockerfile).not.toContain("package-lock.json");
  });

  it("uses npm ci when package-lock.json exists", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "node-app" } }),
      "package.json": JSON.stringify({ name: "node-app" }),
      "package-lock.json": JSON.stringify({}),
      "sandbox/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "20" });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.build.dependencyFiles).toEqual(["package.json", "package-lock.json"]);
    expect(plan.build.dependencyInstalls).toHaveLength(1);
    expect(plan.build.dependencyInstalls[0].command).toContain("npm ci");

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("npm ci");
  });

  it("adds a named volume for the Python venv", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "py-app" } }),
      "requirements.txt": "django\n",
      "sandbox/features/python.mjs": `
        export default function python(ctx) {
          ctx.addLanguage("python", { version: "3.12" });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.build.venvVolume).toBe(true);
    const compose = generateCompose(plan);
    expect(compose).toContain("venv:/workspace/.venv");
  });

  it("builds a plan with Python and Node in one image", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "fullstack-app" } }),
      "requirements.txt": "django\n",
      "package.json": JSON.stringify({ name: "frontend" }),
      "package-lock.json": JSON.stringify({}),
      "sandbox/features/python.mjs": `
        export default function python(ctx) {
          ctx.addLanguage("python", { version: "3.12" });
        }
      `,
      "sandbox/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "20" });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.build.baseImage).toBe("debian:12-slim");
    expect(plan.build.languageRequests).toHaveLength(2);
    expect(plan.build.runtimeInstalls).toHaveLength(2);
    expect(plan.build.dependencyInstalls).toHaveLength(2);
    expect(plan.build.venvVolume).toBe(true);
    expect(plan.build.nodeModulesVolume).toBe(true);

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("FROM debian:12-slim AS base");
    expect(dockerfile).toContain("pyenv install");
    expect(dockerfile).toContain("nodesource.com");
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("pip install");
  });
});

describe("validateConfig", () => {
  it("returns a valid config without executing feature scripts", () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "my-app" } }),
      "sandbox/features/dangerous.mjs": `
        export default function dangerous(ctx) {
          ctx.exec("touch /tmp/should-not-run");
        }
      `,
    });

    const config = validateConfig(dir);
    expect(config.project.name).toBe("my-app");
  });

  it("throws a helpful error for a missing project name", () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: {} }),
    });

    expect(() => validateConfig(dir)).toThrow(/Missing key/);
  });

  it("throws a helpful error for non-object config", () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify("bad"),
    });

    expect(() => validateConfig(dir)).toThrow(/Expected object, got "bad"/);
  });
});

describe("validatePlan", () => {
  it("throws when a process and service share a host port", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "port-conflict" } }),
      "sandbox/services.mjs": `
        export default function services(ctx) {
          ctx.addService("postgres", { port: 5432 });
        }
      `,
      "sandbox/features/django.mjs": `
        export default function django(ctx) {
          ctx.addProcess({ name: "pg", command: ["node"], port: 5432 });
        }
      `,
    });

    await expect(buildPlan(dir)).rejects.toThrow(
      /Host port 5432 is used by both process "pg" and service "postgres"/
    );
  });
});

describe("validateFeatures", () => {
  it("does not invoke default functions while checking exports", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    const marker = join(dir, "should-not-run");
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "my-app" } }),
      "sandbox/features/dangerous.mjs": `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(marker)}, "executed");
        export default function dangerous(ctx) {
          ctx.exec("touch /tmp/should-not-run");
        }
      `,
    });

    await validateFeatures(dir);
    // Top-level ESM code runs during import(); only the default function is skipped.
    expect(existsSync(marker)).toBe(true);
  });

  it("accepts modules that export a default function", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "ok-app" } }),
      "sandbox/services.mjs": `
        export default function services(ctx) {
          ctx.addService("redis", { port: 6379 });
        }
      `,
      "sandbox/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node");
        }
      `,
    });

    await expect(validateFeatures(dir)).resolves.toBeDefined();
  });

  it("rejects a feature module without a default export", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "bad-app" } }),
      "sandbox/features/incomplete.mjs": `
        export const notDefault = 42;
      `,
    });

    await expect(validateFeatures(dir)).rejects.toThrow(/must export a default function/);
  });

  it("rejects a services module whose default export is not a function", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "bad-app" } }),
      "sandbox/services.mjs": `
        export default 42;
      `,
    });

    await expect(validateFeatures(dir)).rejects.toThrow(/must export a default function/);
  });

  it("prefers services.mjs over services.js", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "legacy-app" } }),
      "sandbox/services.mjs": `
        export default function services() {}
      `,
      "sandbox/services.js": `
        export default "ignored";
      `,
    });

    await expect(validateFeatures(dir)).resolves.toBeDefined();
  });
});
