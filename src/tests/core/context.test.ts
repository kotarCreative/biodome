import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxContext } from "../../core/context.js";

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
      ctx.finalizeBuildPlan();

      expect(ctx.plan.build.baseImage).toBe("python:3.12-slim");
      expect(ctx.plan.build.dependencyFiles).toContain("requirements.txt");
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs multiple languages on the neutral base image", () => {
    const dir = makeProject(["package.json", "requirements.txt"]);
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("python", { version: "3.12" });
      ctx.addLanguage("node", { version: "20" });
      ctx.finalizeBuildPlan();

      expect(ctx.plan.build.baseImage).toBe("debian:12-slim");
      expect(ctx.plan.build.runtimeInstalls).toHaveLength(2);
      expect(ctx.plan.build.dependencyFiles).toContain("package.json");
      expect(ctx.plan.build.dependencyFiles).toContain("requirements.txt");
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips Python dependency install when no manifest exists", () => {
    const dir = makeProject();
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("python", { version: "3.12" });
      ctx.finalizeBuildPlan();

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
      ctx.finalizeBuildPlan();

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
      ctx.finalizeBuildPlan();

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
      ctx.finalizeBuildPlan();

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
      ctx.finalizeBuildPlan();

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
      ctx.finalizeBuildPlan();

      expect(ctx.plan.build.dependencyFiles).toEqual(["package.json", "yarn.lock"]);
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(1);
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain("yarn install --frozen-lockfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated addLanguage calls and keeps the last options", () => {
    const dir = makeProject();
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("python", { version: "3.11" });
      ctx.addLanguage("python", { version: "3.12" });
      ctx.finalizeBuildPlan();

      expect(ctx.plan.build.languageRequests).toHaveLength(1);
      expect(ctx.plan.build.baseImage).toBe("python:3.12-slim");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [["python", "node"]],
    [["python", "node", "go"]],
    [["node", "go", "rust"]],
    [["python", "java"]],
    [["python", "node", "go", "rust", "java"]],
  ])("uses the neutral base image and installs %j runtimes", (languages) => {
    const dir = makeProject();
    try {
      const ctx = new SandboxContext(dir, "test");
      for (const name of languages) {
        ctx.addLanguage(name);
      }
      ctx.finalizeBuildPlan();

      expect(ctx.plan.build.baseImage).toBe("debian:12-slim");
      expect(ctx.plan.build.languageRequests).toHaveLength(languages.length);
      expect(ctx.plan.build.runtimeInstalls.length).toBeGreaterThanOrEqual(languages.length);
      const markers: Record<string, string> = {
        python: "pyenv",
        node: "nodesource",
        go: "go.dev",
        rust: "rustup",
        java: "temurin",
      };
      for (const name of languages) {
        expect(ctx.plan.build.runtimeInstalls.some((snippet) => snippet.toLowerCase().includes(markers[name]))).toBe(true);
      }

      if (languages.includes("go")) {
        expect(ctx.plan.build.languageSnippets).toContain("ENV GOPATH=/go");
      }
      if (languages.includes("rust")) {
        expect(ctx.plan.build.languageSnippets).toContain("ENV CARGO_HOME=/usr/local/cargo");
      }
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

  it("adds netcat for tcp health checks", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProcess({
      name: "tcp-app",
      command: ["node", "server.js"],
      port: 3000,
      healthCheck: { type: "tcp", port: 3000 },
    });

    expect(ctx.plan.build.aptPackages).toContain("netcat-openbsd");
  });

  it("rejects duplicate process names", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProcess({ name: "web", command: ["node", "server.js"], port: 3000 });

    expect(() =>
      ctx.addProcess({ name: "web", command: ["node", "server.js"], port: 3001 })
    ).toThrow(/Duplicate process or hook name/);
  });

  it("rejects duplicate service names", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addService("postgres", { port: 5432 });

    expect(() => ctx.addService("postgres", { port: 5433 })).toThrow(
      /Duplicate service name/
    );
  });

  it("does not create orphan volumes for services with no mounts", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addService("custom", { image: "nginx:latest" });

    expect(ctx.plan.runtime.volumes).toHaveLength(0);
  });

  it("rejects a process with a non-array command", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addProcess({
        name: "bad",
        command: "node server.js" as unknown as readonly string[],
        port: 3000,
      })
    ).toThrow(/Expected array, got "node server.js"/);
  });

  it("rejects an invalid lifecycle point", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addProcess({
        name: "bad",
        command: ["node"],
        startOn: "build.middle" as unknown as "build.pre",
      })
    ).toThrow(/Expected .* got "build.middle"/);
  });

  it("rejects an out-of-range port", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addProcess({ name: "bad", command: ["node"], port: 70000 })).toThrow(
      /integer between 1 and 65535/
    );
  });

  it("rejects a service with non-string environment values", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addService("bad", { environment: { COUNT: 42 as unknown as string } })
    ).toThrow(/Expected string, got 42/);
  });

  it("normalizes a relative workingDir to /workspace", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProcess({ name: "web", command: ["node"], workingDir: "frontend" });
    expect(ctx.plan.runtime.processes[0].workingDir).toBe("/workspace/frontend");
  });

  it("preserves an absolute workingDir", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProcess({ name: "web", command: ["node"], workingDir: "/app" });
    expect(ctx.plan.runtime.processes[0].workingDir).toBe("/app");
  });

  it("preserves named ports", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProcess({
      name: "api",
      command: ["node", "server.js"],
      ports: { http: 3000, debug: 9229 },
    });

    const ports = ctx.plan.runtime.processes[0].ports;
    expect(ports).toEqual([
      { name: "http", host: 3000, container: 3000 },
      { name: "debug", host: 9229, container: 9229 },
    ]);
  });
});
