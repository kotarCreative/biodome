import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxContext } from "../../core/context";

function makeProject(files: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-context-"));
  for (const file of files) {
    const fullPath = join(dir, file);
    const parent = fullPath.split("/").slice(0, -1).join("/");
    if (parent) mkdirSync(parent, { recursive: true });
    writeFileSync(fullPath, "");
  }
  return dir;
}

describe("SandboxContext", () => {
  it("adds a daemon process by default", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProcess({
      name: "django",
      command: ["python", "manage.py", "runserver"],
      port: 8000,
    });

    expect(ctx.plan.runtime.processes).toHaveLength(1);
    const proc = ctx.plan.runtime.processes[0];
    expect(proc.name).toBe("django");
    expect(proc.mode).toBe("daemon");
    expect(proc.startOn).toBe("start.post");
    expect(proc.ports).toEqual([{ host: 8000, container: 8000 }]);
  });

  it("adds a hook as a oneshot process", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addHook({
      name: "migrate",
      command: ["python", "manage.py", "migrate"],
      startOn: "start.post",
    });

    const proc = ctx.plan.runtime.processes[0];
    expect(proc.mode).toBe("oneshot");
    expect(proc.startOn).toBe("start.post");
  });

  it("adds a language and sets the base image", () => {
    const dir = makeProject(["requirements.txt"]);
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("python", { version: "3.12" });

      expect(ctx.plan.build.baseImage).toBe("python:3.12-slim");
      expect(ctx.plan.build.dependencyFiles).toContain("requirements.txt");
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when a second language would override the base image", () => {
    const dir = makeProject(["package.json"]);
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("python", { version: "3.12" });
      ctx.addLanguage("node", { version: "20" });

      expect(ctx.plan.build.baseImage).toBe("python:3.12-slim");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips Python dependency install when no manifest exists", () => {
    const dir = makeProject();
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("python", { version: "3.12" });

      expect(ctx.plan.build.baseImage).toBe("python:3.12-slim");
      expect(ctx.plan.build.dependencyFiles).toHaveLength(0);
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses npm ci when package-lock.json exists", () => {
    const dir = makeProject(["package.json", "package-lock.json"]);
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("node", { version: "20" });

      expect(ctx.plan.build.dependencyFiles).toEqual(["package.json", "package-lock.json"]);
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(1);
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain("npm ci");
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain("mkdir -p /workspace/node_modules");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to npm install when no lock file exists", () => {
    const dir = makeProject(["package.json"]);
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("node", { version: "20" });

      expect(ctx.plan.build.dependencyFiles).toEqual(["package.json"]);
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(1);
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain("npm install");
      expect(ctx.plan.build.dependencyInstalls[0].command).not.toContain("npm ci");
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain("mkdir -p /workspace/node_modules");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips Node dependency install when no package.json exists", () => {
    const dir = makeProject();
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("node", { version: "20" });

      expect(ctx.plan.build.dependencyFiles).toHaveLength(0);
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses pnpm frozen-lockfile when pnpm-lock.yaml exists", () => {
    const dir = makeProject(["package.json", "pnpm-lock.yaml"]);
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("node", { version: "20", packageManager: "pnpm" });

      expect(ctx.plan.build.dependencyFiles).toEqual(["package.json", "pnpm-lock.yaml"]);
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(1);
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain("pnpm install --frozen-lockfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses yarn frozen-lockfile when yarn.lock exists", () => {
    const dir = makeProject(["package.json", "yarn.lock"]);
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("node", { version: "20", packageManager: "yarn" });

      expect(ctx.plan.build.dependencyFiles).toEqual(["package.json", "yarn.lock"]);
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(1);
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain("yarn install --frozen-lockfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds a tool and treats unknown tools as apt packages", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addTool("curl");
    ctx.addTool("curl");
    ctx.addTool("git");

    expect(ctx.plan.build.aptPackages).toEqual(["curl", "git"]);
  });

  it("adds a service and generates a health check", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addService("postgres", {
      port: 5432,
      databases: [{ name: "myapp" }],
      users: [{ name: "app", password: "dev" }],
    });

    const svc = ctx.plan.runtime.services[0];
    expect(svc.type).toBe("postgres");
    expect(svc.image).toBe("postgres:16-alpine");
    expect(svc.healthCheck).toBeDefined();
    expect(svc.healthCheck?.test[0]).toBe("CMD-SHELL");
  });

  it("sets env in both build and runtime", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.setEnv("DEBUG", "1");

    expect(ctx.plan.build.environment.DEBUG).toBe("1");
    expect(ctx.plan.runtime.environment.DEBUG).toBe("1");
  });

  it("adds curl for http health checks", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProcess({
      name: "web",
      command: ["node", "server.js"],
      port: 3000,
      healthCheck: { type: "http", url: "http://localhost:3000/health" },
    });

    expect(ctx.plan.build.aptPackages).toContain("curl");
  });
});
