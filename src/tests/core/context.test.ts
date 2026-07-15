import { describe, it, expect } from "vitest";
import { SandboxContext } from "../../core/context";

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
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addLanguage("python", { version: "3.12" });

    expect(ctx.plan.build.baseImage).toBe("python:3.12-slim");
    expect(ctx.plan.build.dependencyFiles).toContain("requirements.txt");
  });

  it("adds an apt package uniquely", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addAptPackage("curl");
    ctx.addAptPackage("curl");
    ctx.addAptPackage("git");

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
