import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildPlan } from "../../builder/index";
import { generateDockerfile } from "../../docker/generator";

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
  it("loads config and features", () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "my-app" } }),
      "sandbox/services.js": `
        const ctx = sandbox.ctx();
        ctx.addService("postgres", { port: 5432 });
      `,
      "sandbox/features/django.js": `
        const ctx = sandbox.ctx();
        ctx.addLanguage("python", { version: "3.12" });
        ctx.addProcess({
          name: "django",
          command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
          port: 8000,
        });
      `,
    });

    const plan = buildPlan(dir);
    expect(plan.project).toBe("my-app");
    expect(plan.build.baseImage).toBe("python:3.12-slim");
    expect(plan.runtime.processes).toHaveLength(1);
    expect(plan.runtime.services).toHaveLength(1);
    expect(plan.runtime.services[0].name).toBe("postgres");
  });

  it("executes arbitrary commands in features", () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "cmd-app" } }),
      "sandbox/features/env.js": `
        const ctx = sandbox.ctx();
        const result = ctx.exec("echo branch=main");
        ctx.setEnv("BRANCH", result.stdout.trim().split("=")[1]);
      `,
    });

    const plan = buildPlan(dir);
    expect(plan.runtime.environment.BRANCH).toBe("main");
  });

  it("uses npm install when no lock file exists", () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "node-app" } }),
      "package.json": JSON.stringify({ name: "node-app" }),
      "sandbox/features/node.js": `
        const ctx = sandbox.ctx();
        ctx.addLanguage("node", { version: "20" });
      `,
    });

    const plan = buildPlan(dir);
    expect(plan.build.dependencyFiles).toEqual(["package.json"]);
    expect(plan.build.dependencyInstalls).toHaveLength(1);
    expect(plan.build.dependencyInstalls[0].command).toContain("npm install");

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("npm install");
    expect(dockerfile).not.toContain("npm ci");
    expect(dockerfile).not.toContain("package-lock.json");
  });

  it("uses npm ci when package-lock.json exists", () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "node-app" } }),
      "package.json": JSON.stringify({ name: "node-app" }),
      "package-lock.json": JSON.stringify({}),
      "sandbox/features/node.js": `
        const ctx = sandbox.ctx();
        ctx.addLanguage("node", { version: "20" });
      `,
    });

    const plan = buildPlan(dir);
    expect(plan.build.dependencyFiles).toEqual(["package.json", "package-lock.json"]);
    expect(plan.build.dependencyInstalls).toHaveLength(1);
    expect(plan.build.dependencyInstalls[0].command).toContain("npm ci");

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("npm ci");
  });
});
