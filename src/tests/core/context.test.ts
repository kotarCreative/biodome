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
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain(
        "mkdir -p /workspace/node_modules",
      );
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
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain(
        "mkdir -p /workspace/node_modules",
      );
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
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain(
        "pnpm install --frozen-lockfile",
      );
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
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain(
        "yarn install --frozen-lockfile",
      );
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

  it("adds PHP and sets the base image", () => {
    const dir = makeProject();
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("php", { version: "8.3" });
      ctx.finalizeBuildPlan();

      expect(ctx.plan.build.baseImage).toBe("php:8.3-cli");
      expect(ctx.plan.build.languageSnippets.some((s) => s.includes("getcomposer.org"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs PHP dependencies from composer.json", () => {
    const dir = makeProject(["composer.json"]);
    try {
      const ctx = new SandboxContext(dir, "test");
      ctx.addLanguage("php", { version: "8.3" });
      ctx.finalizeBuildPlan();

      expect(ctx.plan.build.dependencyFiles).toEqual(["composer.json"]);
      expect(ctx.plan.build.dependencyInstalls).toHaveLength(1);
      expect(ctx.plan.build.dependencyInstalls[0].command).toContain("composer install");
      expect(ctx.plan.build.copyArtifacts[0].lines).toContain(
        "COPY --from=deps /workspace/vendor /workspace/vendor",
      );
      expect(ctx.plan.build.vendorVolume).toBe(true);
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
    [["php", "node"]],
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
        php: "sury",
      };
      for (const name of languages) {
        expect(
          ctx.plan.build.runtimeInstalls.some((snippet) =>
            snippet.toLowerCase().includes(markers[name]),
          ),
        ).toBe(true);
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

  it("adds a literal env var scoped to runtime by default", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEnv("DEBUG", { value: "1" });

    expect(ctx.plan.build.environment.DEBUG).toBeUndefined();
    expect(ctx.plan.runtime.environment.DEBUG).toBe("1");
    expect(ctx.plan.runtime.envVars).toEqual([{ key: "DEBUG", scope: "runtime", value: "1" }]);
  });

  it("adds a literal env var to both build and runtime with scope 'both'", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEnv("DEBUG", { value: "1", scope: "both" });

    expect(ctx.plan.build.environment.DEBUG).toBe("1");
    expect(ctx.plan.runtime.environment.DEBUG).toBe("1");
  });

  it("scopes a literal env var to runtime only", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEnv("RUNTIME_ONLY", { value: "yes", scope: "runtime" });

    expect(ctx.plan.build.environment.RUNTIME_ONLY).toBeUndefined();
    expect(ctx.plan.runtime.environment.RUNTIME_ONLY).toBe("yes");
  });

  it("scopes a literal env var to build only", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEnv("BUILD_ONLY", { value: "yes", scope: "build" });

    expect(ctx.plan.build.environment.BUILD_ONLY).toBe("yes");
    expect(ctx.plan.runtime.environment.BUILD_ONLY).toBeUndefined();
  });

  it("adds a passthrough env var without baking its value into the plan", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEnv("DATABASE_URL", { from: { env: "DATABASE_URL" }, required: true });

    // Passthrough values never touch the literal env maps.
    expect(ctx.plan.build.environment.DATABASE_URL).toBeUndefined();
    expect(ctx.plan.runtime.environment.DATABASE_URL).toBeUndefined();
    expect(ctx.plan.runtime.envVars[0]).toEqual({
      key: "DATABASE_URL",
      scope: "runtime",
      from: { env: "DATABASE_URL" },
      required: true,
      default: undefined,
    });
  });

  it("supports a default on a passthrough env var", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEnv("PORT", { from: { env: "PORT" }, default: "8000" });

    expect(ctx.plan.runtime.envVars[0].default).toBe("8000");
  });

  it("rejects an env var with both value and from", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addEnv("X", { value: "1", from: { env: "X" } })).toThrow(
      /exactly one of 'value'/,
    );
  });

  it("rejects an env var with neither value nor from", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addEnv("X", {})).toThrow(/exactly one of 'value'/);
  });

  it("rejects required/default on a literal env var", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addEnv("X", { value: "1", required: true })).toThrow(
      /only apply to passthrough/,
    );
  });

  it("rejects an unsafe default for compose interpolation", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addEnv("PORT", { from: { env: "PORT" }, default: "8:000" })).toThrow(
      /not safe inside a Docker Compose interpolation default/,
    );
  });

  it("rejects an invalid env key", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addEnv("1BAD", { value: "1" })).toThrow(/must match/);
    expect(() => ctx.addEnv("has-dash", { value: "1" })).toThrow(/must match/);
  });

  it("rejects duplicate env keys", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEnv("DEBUG", { value: "1" });
    expect(() => ctx.addEnv("DEBUG", { value: "0" })).toThrow(/Duplicate env variable/);
  });

  it("does not let a process environment overwrite an addEnv variable", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEnv("DEBUG", { value: "1" });
    ctx.addProcess({
      name: "web",
      command: ["node", "server.js"],
      environment: { DEBUG: "0" },
    });

    expect(ctx.plan.runtime.environment.DEBUG).toBe("1");
    const proc = ctx.plan.runtime.processes[0];
    expect(proc.environment.DEBUG).toBe("0");
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
      ctx.addProcess({ name: "web", command: ["node", "server.js"], port: 3001 }),
    ).toThrow(/Duplicate process or hook name/);
  });

  it("rejects duplicate service names", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addService("postgres", { port: 5432 });

    expect(() => ctx.addService("postgres", { port: 5433 })).toThrow(/Duplicate service name/);
  });

  it("adds an endpoint with literal and env-referenced credentials", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEndpoint({
      name: "django-api",
      description: "Django REST API",
      url: "http://localhost:8000",
      port: 8000,
      credentials: {
        username: "admin",
        password: { env: "DJANGO_ADMIN_PASSWORD" },
        token: { env: "DJANGO_API_TOKEN" },
      },
      metadata: { framework: "django" },
    });

    expect(ctx.plan.runtime.endpoints).toHaveLength(1);
    const endpoint = ctx.plan.runtime.endpoints[0];
    expect(endpoint.name).toBe("django-api");
    expect(endpoint.url).toBe("http://localhost:8000");
    expect(endpoint.port).toBe(8000);
    expect(endpoint.credentials).toEqual({
      username: "admin",
      password: { env: "DJANGO_ADMIN_PASSWORD" },
      token: { env: "DJANGO_API_TOKEN" },
    });
    expect(endpoint.metadata).toEqual({ framework: "django" });
  });

  it("adds a minimal endpoint with only a name", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEndpoint({ name: "worker" });

    const endpoint = ctx.plan.runtime.endpoints[0];
    expect(endpoint.name).toBe("worker");
    expect(endpoint.credentials).toBeUndefined();
    expect(endpoint.metadata).toBeUndefined();
  });

  it("rejects duplicate endpoint names", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addEndpoint({ name: "api", port: 8000 });

    expect(() => ctx.addEndpoint({ name: "api", port: 8001 })).toThrow(/Duplicate endpoint name/);
  });

  it("rejects an endpoint with an out-of-range port", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addEndpoint({ name: "api", port: 70000 })).toThrow(
      /integer between 1 and 65535/,
    );
  });

  it("adds a generic provider with credentials and metadata", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProvider({
      name: "github",
      type: "github",
      url: "https://api.github.com",
      credentials: {
        token: { env: "GITHUB_TOKEN" },
      },
      metadata: { org: "acme" },
    });

    expect(ctx.plan.runtime.providers).toHaveLength(1);
    const provider = ctx.plan.runtime.providers[0];
    expect(provider.name).toBe("github");
    expect(provider.type).toBe("github");
    expect(provider.url).toBe("https://api.github.com");
    expect(provider.credentials).toEqual({ token: { env: "GITHUB_TOKEN" } });
    expect(provider.metadata).toEqual({ org: "acme" });
  });

  it("adds a Jira provider through the helper", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addJiraProvider({
      name: "jira",
      mcpUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
      project: "PROJ",
      credentials: {
        token: { env: "JIRA_TOKEN" },
      },
      metadata: { team: "platform" },
    });

    const provider = ctx.plan.runtime.providers[0];
    expect(provider.type).toBe("jira");
    expect(provider.mcpUrl).toBe("https://mcp.atlassian.com/v1/mcp/authv2");
    expect(provider.authHeader).toBe("Authorization");
    expect(provider.authScheme).toBe("Bearer ");
    expect(provider.authCredential).toBe("token");
    expect(provider.project).toBe("PROJ");
    expect(provider.credentials).toEqual({
      token: { env: "JIRA_TOKEN" },
    });
  });

  it("rejects a Jira provider without a token", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addJiraProvider({
        name: "jira",
        credentials: {} as any,
      }),
    ).toThrow(/credentials.token is required/);
  });

  it("rejects duplicate provider names", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addProvider({ name: "jira", type: "jira" });
    expect(() => ctx.addProvider({ name: "jira", type: "jira" })).toThrow(
      /Duplicate provider name/,
    );
  });

  it("adds a Linear provider through the helper", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addLinearProvider({
      name: "linear",
      team: "TEAM",
      credentials: {
        token: { env: "LINEAR_TOKEN" },
      },
      metadata: { team: "platform" },
    });

    const provider = ctx.plan.runtime.providers[0];
    expect(provider.type).toBe("linear");
    expect(provider.mcpUrl).toBe("https://mcp.linear.app/mcp");
    expect(provider.authHeader).toBe("Authorization");
    expect(provider.authScheme).toBe("Bearer ");
    expect(provider.authCredential).toBe("token");
    expect(provider.project).toBe("TEAM");
    expect(provider.credentials).toEqual({ token: { env: "LINEAR_TOKEN" } });
  });

  it("rejects a Linear provider without a token", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addLinearProvider({
        name: "linear",
        credentials: {} as any,
      }),
    ).toThrow(/credentials.token is required/);
  });

  it("rejects an endpoint with an empty env reference", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addEndpoint({ name: "api", credentials: { token: { env: "" } } })).toThrow();
  });

  it("does not create orphan volumes for services with no mounts", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addService("custom", { image: "nginx:latest" });

    expect(ctx.plan.runtime.namedVolumes).toHaveLength(0);
  });

  it("rejects a process with a non-array command", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addProcess({
        name: "bad",
        command: "node server.js" as unknown as readonly string[],
        port: 3000,
      }),
    ).toThrow(/Expected array, got "node server.js"/);
  });

  it("rejects an invalid lifecycle point", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addProcess({
        name: "bad",
        command: ["node"],
        startOn: "build.middle" as unknown as "build.pre",
      }),
    ).toThrow(/Expected .* got "build.middle"/);
  });

  it("rejects an out-of-range port", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addProcess({ name: "bad", command: ["node"], port: 70000 })).toThrow(
      /integer between 1 and 65535/,
    );
  });

  it("rejects a service with non-string environment values", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addService("bad", { environment: { COUNT: 42 as unknown as string } }),
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

  it("configureMcp adds the MCP process and sets flags", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.configureMcp(3005);

    expect(ctx.plan.build.mcpEnabled).toBe(true);
    expect(ctx.plan.build.mcpPort).toBe(3005);

    const procs = ctx.plan.runtime.processes;
    expect(procs).toHaveLength(1);
    const mcp = procs[0];
    expect(mcp.name).toBe("biodome-mcp");
    expect(mcp.command[0]).toBe("node");
    expect(mcp.command).toContain("/workspace/.biodome-build/mcp-server.js");
    expect(mcp.command).toContain("--port");
    expect(mcp.command).toContain("3005");
    expect(mcp.ports).toHaveLength(1);
    expect(mcp.ports[0].host).toBe(3005);
    expect(mcp.ports[0].container).toBe(3005);
    expect(mcp.healthCheck).toBeDefined();
    expect(mcp.healthCheck!.url).toContain("localhost:3005");
  });

  describe("addVolume", () => {
    it("adds a local bind-mount volume", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "data",
        type: "local",
        source: "./data",
        target: "/workspace/data",
      });

      expect(ctx.plan.runtime.volumes).toHaveLength(1);
      const volume = ctx.plan.runtime.volumes[0];
      expect(volume.name).toBe("data");
      expect(volume.type).toBe("local");
      expect(volume.source).toBe("./data");
      expect(volume.target).toBe("/workspace/data");
      expect(ctx.plan.build.aptPackages).not.toContain("rclone");
      expect(ctx.plan.runtime.processes).toHaveLength(0);
    });

    it("adds an S3 bucket mount as a daemon process", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "s3-data",
        type: "s3",
        bucket: "my-bucket",
        prefix: "data/",
        target: "/workspace/s3-data",
        credentials: {
          accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
          secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
        },
      });

      expect(ctx.plan.runtime.volumes).toHaveLength(1);
      expect(ctx.plan.build.aptPackages).toContain("rclone");
      expect(ctx.plan.build.aptPackages).toContain("fuse3");

      const proc = ctx.plan.runtime.processes[0];
      expect(proc.name).toBe("rclone-mount-s3-data");
      expect(proc.mode).toBe("daemon");
      expect(proc.command).toEqual([
        "rclone",
        "mount",
        "s3:my-bucket/data/",
        "/workspace/s3-data",
        "--allow-other",
        "--vfs-cache-mode",
        "writes",
      ]);
      expect(proc.environment).toEqual({
        RCLONE_S3_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID}",
        RCLONE_S3_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY}",
      });
    });

    it("adds an S3 prefix mount for file access without copying", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "s3-configs",
        type: "s3",
        bucket: "my-bucket",
        prefix: "configs/",
        target: "/workspace/s3-configs",
        credentials: {
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
        },
      });

      const proc = ctx.plan.runtime.processes[0];
      expect(proc.name).toBe("rclone-mount-s3-configs");
      expect(proc.mode).toBe("daemon");
      expect(proc.command).toContain("s3:my-bucket/configs/");
      expect(proc.command).toContain("/workspace/s3-configs");
      expect(proc.environment).toEqual({
        RCLONE_S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        RCLONE_S3_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY}",
      });
    });

    it("adds Dropbox and Google Drive mounts", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "dropbox",
        type: "dropbox",
        path: "/Projects",
        target: "/workspace/dropbox",
        credentials: { token: { env: "DROPBOX_TOKEN" } },
      });
      ctx.addVolume({
        name: "gdrive",
        type: "gdrive",
        path: "/Documents",
        target: "/workspace/gdrive",
        credentials: {
          clientId: { env: "GDRIVE_CLIENT_ID" },
          clientSecret: { env: "GDRIVE_CLIENT_SECRET" },
          token: { env: "GDRIVE_TOKEN" },
        },
      });

      const dropbox = ctx.plan.runtime.processes.find((p) => p.name === "rclone-mount-dropbox");
      expect(dropbox?.command).toContain("dropbox:/Projects");
      expect(dropbox?.environment).toEqual({ RCLONE_DROPBOX_TOKEN: "${DROPBOX_TOKEN}" });

      const gdrive = ctx.plan.runtime.processes.find((p) => p.name === "rclone-mount-gdrive");
      expect(gdrive?.command).toContain("drive:/Documents");
      expect(gdrive?.environment).toEqual({
        RCLONE_DRIVE_CLIENT_ID: "${GDRIVE_CLIENT_ID}",
        RCLONE_DRIVE_CLIENT_SECRET: "${GDRIVE_CLIENT_SECRET}",
        RCLONE_DRIVE_TOKEN: "${GDRIVE_TOKEN}",
      });
    });

    it("rejects duplicate volume names", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({ name: "data", type: "local", source: "./a", target: "/workspace/a" });
      expect(() =>
        ctx.addVolume({ name: "data", type: "local", source: "./b", target: "/workspace/b" }),
      ).toThrow(/Duplicate volume name/);
    });

    it("rejects local volumes without a source", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() =>
        ctx.addVolume({ name: "data", type: "local", target: "/workspace/data" } as any),
      ).toThrow(/local volumes require a source path/);
    });

    it("rejects S3 volumes without a bucket", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() =>
        ctx.addVolume({ name: "s3", type: "s3", target: "/workspace/s3" } as any),
      ).toThrow(/S3 volumes require a bucket/);
    });

    it("rejects cloud volumes without a path", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() =>
        ctx.addVolume({ name: "db", type: "dropbox", target: "/workspace/db" } as any),
      ).toThrow(/dropbox volumes require a path/);
      expect(() =>
        ctx.addVolume({ name: "gd", type: "gdrive", target: "/workspace/gd" } as any),
      ).toThrow(/gdrive volumes require a path/);
    });

    it("adds GCS, Azure, SFTP, SMB, and WebDAV mounts", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "gcs",
        type: "gcs",
        bucket: "my-bucket",
        prefix: "data/",
        target: "/workspace/gcs",
        credentials: { token: { env: "GCS_TOKEN" } },
      });
      ctx.addVolume({
        name: "azure",
        type: "azure",
        account: "myaccount",
        container: "mycontainer",
        path: "backups/",
        target: "/workspace/azure",
        credentials: { accountKey: { env: "AZURE_KEY" } },
      });
      ctx.addVolume({
        name: "sftp",
        type: "sftp",
        host: "files.example.com",
        port: 2222,
        path: "/srv/data",
        target: "/workspace/sftp",
        credentials: { user: "admin", password: { env: "SFTP_PASS" } },
      });
      ctx.addVolume({
        name: "smb",
        type: "smb",
        host: "nas.local",
        share: "shared",
        target: "/workspace/smb",
        credentials: { user: { env: "SMB_USER" }, password: { env: "SMB_PASS" } },
      });
      ctx.addVolume({
        name: "webdav",
        type: "webdav",
        url: "https://cloud.example.com/webdav",
        path: "projects",
        target: "/workspace/webdav",
        vendor: "nextcloud",
        credentials: { user: "admin", password: { env: "WEBDAV_PASS" } },
      });

      const gcs = ctx.plan.runtime.processes.find((p) => p.name === "rclone-mount-gcs");
      expect(gcs?.command).toContain("gcs:my-bucket/data/");
      expect(gcs?.environment).toEqual({ RCLONE_GCS_TOKEN: "${GCS_TOKEN}" });

      const azure = ctx.plan.runtime.processes.find((p) => p.name === "rclone-mount-azure");
      expect(azure?.command).toContain("azure:mycontainer/backups/");
      expect(azure?.environment).toEqual({
        RCLONE_AZURE_ACCOUNT: "myaccount",
        RCLONE_AZURE_KEY: "${AZURE_KEY}",
      });

      const sftp = ctx.plan.runtime.processes.find((p) => p.name === "rclone-mount-sftp");
      expect(sftp?.command).toContain("sftp:/srv/data");
      expect(sftp?.environment).toEqual({
        RCLONE_SFTP_HOST: "files.example.com",
        RCLONE_SFTP_PORT: "2222",
        RCLONE_SFTP_USER: "admin",
        RCLONE_SFTP_PASS: "${SFTP_PASS}",
      });

      const smb = ctx.plan.runtime.processes.find((p) => p.name === "rclone-mount-smb");
      expect(smb?.command).toContain("smb:nas.local/shared");
      expect(smb?.environment).toEqual({
        RCLONE_SMB_HOST: "nas.local",
        RCLONE_SMB_USER: "${SMB_USER}",
        RCLONE_SMB_PASS: "${SMB_PASS}",
      });

      const webdav = ctx.plan.runtime.processes.find((p) => p.name === "rclone-mount-webdav");
      expect(webdav?.command).toContain("webdav:projects");
      expect(webdav?.environment).toEqual({
        RCLONE_WEBDAV_URL: "https://cloud.example.com/webdav",
        RCLONE_WEBDAV_VENDOR: "nextcloud",
        RCLONE_WEBDAV_USER: "admin",
        RCLONE_WEBDAV_PASS: "${WEBDAV_PASS}",
      });
    });

    it("supports S3-compatible endpoints via the endpoint credential", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "minio",
        type: "s3",
        bucket: "my-bucket",
        target: "/workspace/minio",
        credentials: {
          accessKeyId: { env: "MINIO_ACCESS_KEY" },
          secretAccessKey: { env: "MINIO_SECRET_KEY" },
          endpoint: "http://minio:9000",
        },
      });

      const proc = ctx.plan.runtime.processes[0];
      expect(proc.environment).toEqual({
        RCLONE_S3_ACCESS_KEY_ID: "${MINIO_ACCESS_KEY}",
        RCLONE_S3_SECRET_ACCESS_KEY: "${MINIO_SECRET_KEY}",
        RCLONE_S3_ENDPOINT: "http://minio:9000",
      });
    });

    it("does not mount proxy volumes in the dev container", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "s3-proxy",
        type: "s3",
        bucket: "my-bucket",
        target: "/workspace/s3-proxy",
        proxy: true,
        credentials: {
          accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
          secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
        },
      });

      expect(ctx.plan.runtime.volumes).toHaveLength(1);
      expect(ctx.plan.runtime.volumes[0].proxy).toBe(true);
      expect(ctx.plan.build.aptPackages).not.toContain("rclone");
      expect(ctx.plan.runtime.processes).toHaveLength(0);
    });

    it("isolates proxy-volume credentials in the MCP process environment", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "s3-proxy",
        type: "s3",
        bucket: "my-bucket",
        target: "/workspace/s3-proxy",
        proxy: true,
        credentials: {
          accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
          secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
        },
      });
      ctx.configureMcp(3001);

      const mcp = ctx.plan.runtime.processes.find((p) => p.name === "biodome-mcp");
      expect(mcp).toBeDefined();
      expect(mcp!.mergeEnv).toBe(false);
      expect(mcp!.environment.AWS_ACCESS_KEY_ID).toBe("${AWS_ACCESS_KEY_ID}");
      expect(mcp!.environment.AWS_SECRET_ACCESS_KEY).toBe("${AWS_SECRET_ACCESS_KEY}");
      // Credentials must not leak into the dev service's global environment.
      expect(ctx.plan.runtime.environment.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(ctx.plan.runtime.environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    });

    it("supports local proxy volumes that are not mounted in the container", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addVolume({
        name: "local-proxy",
        type: "local",
        source: "./data",
        target: "/workspace/data",
        proxy: true,
        allowedPaths: ["**/*.txt"],
      });

      expect(ctx.plan.runtime.volumes).toHaveLength(1);
      expect(ctx.plan.runtime.volumes[0].proxy).toBe(true);
      expect(ctx.plan.runtime.processes).toHaveLength(0);
    });

    it("adds volumes through wrapper helpers", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addLocalVolume({ name: "data", source: "./data", target: "/workspace/data" });
      ctx.addS3Volume({
        name: "s3",
        bucket: "bucket",
        target: "/workspace/s3",
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
      });
      ctx.addGcsVolume({
        name: "gcs",
        bucket: "bucket",
        target: "/workspace/gcs",
        credentials: { token: { env: "GCS_TOKEN" } },
      });
      ctx.addAzureVolume({
        name: "azure",
        account: "acc",
        container: "cont",
        target: "/workspace/azure",
        credentials: { accountKey: { env: "AZURE_KEY" } },
      });
      ctx.addSftpVolume({
        name: "sftp",
        host: "host",
        path: "/data",
        target: "/workspace/sftp",
        credentials: { user: "u" },
      });
      ctx.addSmbVolume({
        name: "smb",
        host: "host",
        share: "share",
        target: "/workspace/smb",
        credentials: { user: "u" },
      });
      ctx.addWebdavVolume({
        name: "webdav",
        url: "https://example.com/dav",
        target: "/workspace/webdav",
      });
      ctx.addDropboxVolume({
        name: "dropbox",
        path: "/p",
        target: "/workspace/dropbox",
        credentials: { token: { env: "T" } },
      });
      ctx.addGdriveVolume({
        name: "gdrive",
        path: "/p",
        target: "/workspace/gdrive",
        credentials: {
          clientId: "a",
          clientSecret: "b",
          token: { env: "T" },
        },
      });

      expect(ctx.plan.runtime.volumes).toHaveLength(9);
      expect(ctx.plan.runtime.volumes[0].type).toBe("local");
      expect(ctx.plan.runtime.volumes[1].type).toBe("s3");
      expect(ctx.plan.runtime.volumes[2].type).toBe("gcs");
      expect(ctx.plan.runtime.volumes[3].type).toBe("azure");
      expect(ctx.plan.runtime.volumes[4].type).toBe("sftp");
      expect(ctx.plan.runtime.volumes[5].type).toBe("smb");
      expect(ctx.plan.runtime.volumes[6].type).toBe("webdav");
      expect(ctx.plan.runtime.volumes[7].type).toBe("dropbox");
      expect(ctx.plan.runtime.volumes[8].type).toBe("gdrive");
    });
  });

  describe("addMcpProvider", () => {
    it("requires mcpUrl", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() =>
        ctx.addMcpProvider({
          name: "x",
          type: "custom",
          mcpUrl: "",
          credentials: { token: "abc" },
        } as any),
      ).toThrow(/mcpUrl is required/);
    });

    it("requires credentials.token", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() =>
        ctx.addMcpProvider({
          name: "x",
          type: "custom",
          mcpUrl: "http://example.com/mcp",
          credentials: {} as any,
        }),
      ).toThrow(/credentials.token is required/);
    });

    it("sets default auth fields", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addMcpProvider({
        name: "sentry",
        type: "sentry",
        mcpUrl: "https://mcp.sentry.dev/mcp",
        credentials: { token: { env: "SENTRY_TOKEN" } },
      });
      const p = ctx.plan.runtime.providers[0];
      expect(p.name).toBe("sentry");
      expect(p.mcpUrl).toBe("https://mcp.sentry.dev/mcp");
      expect(p.authHeader).toBe("Authorization");
      expect(p.authScheme).toBe("Bearer ");
      expect(p.authCredential).toBe("token");
      expect(p.credentials).toEqual({ token: { env: "SENTRY_TOKEN" } });
    });
  });

  it("adds a Sentry provider through the helper", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addSentryProvider({
      name: "sentry",
      credentials: { token: { env: "SENTRY_TOKEN" } },
    });

    const provider = ctx.plan.runtime.providers[0];
    expect(provider.type).toBe("sentry");
    expect(provider.mcpUrl).toBe("https://mcp.sentry.dev/mcp");
    expect(provider.authHeader).toBe("Authorization");
    expect(provider.authScheme).toBe("Bearer ");
    expect(provider.credentials).toEqual({ token: { env: "SENTRY_TOKEN" } });
  });

  it("rejects a Sentry provider without a token", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addSentryProvider({ name: "sentry", credentials: {} as any })).toThrow(
      /credentials.token is required/,
    );
  });

  it("adds a Slack provider through the helper", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addSlackProvider({
      name: "slack",
      mcpUrl: "https://slack.example.com/mcp",
      credentials: { token: { env: "SLACK_TOKEN" } },
    });

    const provider = ctx.plan.runtime.providers[0];
    expect(provider.type).toBe("slack");
    expect(provider.mcpUrl).toBe("https://slack.example.com/mcp");
    expect(provider.credentials).toEqual({ token: { env: "SLACK_TOKEN" } });
  });

  it("rejects a Slack provider without mcpUrl", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() =>
      ctx.addSlackProvider({ name: "slack", credentials: { token: "x" } } as any),
    ).toThrow(/mcpUrl is required/);
  });

  it("adds a GitHub provider through the helper", () => {
    const ctx = new SandboxContext("/tmp", "test");
    ctx.addGithubProvider({
      name: "github",
      credentials: { token: { env: "GITHUB_TOKEN" } },
    });

    const provider = ctx.plan.runtime.providers[0];
    expect(provider.type).toBe("github");
    expect(provider.mcpUrl).toBe("https://api.githubcopilot.com/mcp/");
    expect(provider.credentials).toEqual({ token: { env: "GITHUB_TOKEN" } });
  });

  it("rejects a GitHub provider without a token", () => {
    const ctx = new SandboxContext("/tmp", "test");
    expect(() => ctx.addGithubProvider({ name: "github", credentials: {} as any })).toThrow(
      /credentials.token is required/,
    );
  });

  describe("provider credential isolation in configureMcp", () => {
    it("isolates provider credential env refs in the MCP process environment", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addProvider({
        name: "jira",
        type: "jira",
        mcpUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
        credentials: { token: { env: "JIRA_TOKEN" } },
      });
      ctx.configureMcp(3001);

      const mcp = ctx.plan.runtime.processes.find((p) => p.name === "biodome-mcp");
      expect(mcp).toBeDefined();
      expect(mcp!.mergeEnv).toBe(false);
      expect(mcp!.environment.JIRA_TOKEN).toBe("${JIRA_TOKEN}");
      // Provider credentials must not leak into the dev service's global environment.
      expect(ctx.plan.runtime.environment.JIRA_TOKEN).toBeUndefined();
    });
  });

  describe("addRepo", () => {
    it("adds a repo with defaults and creates a start.post sync hook", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addRepo({
        name: "backend",
        url: "https://github.com/acme/backend.git",
      });

      expect(ctx.plan.runtime.repos).toHaveLength(1);
      const repo = ctx.plan.runtime.repos[0];
      expect(repo.name).toBe("backend");
      expect(repo.url).toBe("https://github.com/acme/backend.git");
      expect(repo.path).toBe("/workspace/repos/backend");
      expect(repo.branch).toBe("main");

      expect(ctx.plan.build.aptPackages).toContain("git");
      expect(ctx.plan.build.aptPackages).toContain("openssh-client");

      const hook = ctx.plan.runtime.processes[0];
      expect(hook.name).toBe("repo-sync-backend");
      expect(hook.mode).toBe("oneshot");
      expect(hook.startOn).toBe("start.post");
      expect(hook.command).toEqual(["sh", "/workspace/.biodome-build/repos/backend.sh"]);
    });

    it("adds a repo with custom path, branch, and depth", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addRepo({
        name: "frontend",
        url: "https://github.com/acme/frontend.git",
        path: "apps/frontend",
        branch: "develop",
        depth: 1,
      });

      const repo = ctx.plan.runtime.repos[0];
      expect(repo.path).toBe("/workspace/apps/frontend");
      expect(repo.branch).toBe("develop");
      expect(repo.depth).toBe(1);
    });

    it("supports token credentials via environment reference", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addRepo({
        name: "backend",
        url: "https://github.com/acme/backend.git",
        credentials: { token: { env: "GITHUB_TOKEN" } },
      });

      const repo = ctx.plan.runtime.repos[0];
      expect(repo.credentials).toEqual({ token: { env: "GITHUB_TOKEN" } });
    });

    it("supports ssh key credentials via environment reference", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addRepo({
        name: "backend",
        url: "git@github.com:acme/backend.git",
        credentials: { sshKey: { env: "BACKEND_SSH_KEY" } },
      });

      const repo = ctx.plan.runtime.repos[0];
      expect(repo.credentials).toEqual({ sshKey: { env: "BACKEND_SSH_KEY" } });
    });

    it("rejects duplicate repo names", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addRepo({ name: "backend", url: "https://github.com/acme/backend.git" });
      expect(() =>
        ctx.addRepo({ name: "backend", url: "https://github.com/acme/backend2.git" }),
      ).toThrow(/Duplicate repo name/);
    });

    it("rejects literal credential strings for security", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() =>
        ctx.addRepo({
          name: "backend",
          url: "https://github.com/acme/backend.git",
          credentials: { token: "ghp_secret" },
        }),
      ).toThrow(/must be an environment reference/);
    });
  });

  describe("addOpencodeHarness", () => {
    it("adds an opencode harness with defaults", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.configureMcp(3001);
      ctx.addOpencodeHarness({ name: "agent" });

      expect(ctx.plan.runtime.agentHarnesses).toHaveLength(1);
      const harness = ctx.plan.runtime.agentHarnesses[0];
      expect(harness.name).toBe("agent");
      expect(harness.type).toBe("opencode");
      expect(harness.port).toBe(3002);
      expect(harness.mcpServers).toEqual({ biodome: { url: "http://localhost:3001" } });
      expect(harness.telemetry.enabled).toBe(true);
      expect(harness.telemetry.path).toBe("/workspace/.biodome-build/logs/opencode-events.jsonl");
      expect(harness.telemetry.capturePayloads).toBe(false);

      const proc = ctx.plan.runtime.processes.find((p) => p.name === "opencode-agent-agent");
      expect(proc).toBeDefined();
      expect(proc!.mode).toBe("daemon");
      expect(proc!.command).toContain("sh");
      expect(proc!.command).toContain("/workspace/.biodome-build/opencode-homes/agent/start.sh");
      expect(proc!.environment!.HOME).toBe("/workspace/.biodome-build/opencode-homes/agent");

      expect(ctx.plan.build.aptPackages).toContain("curl");
    });

    it("uses custom port and mcp servers", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addOpencodeHarness({
        name: "agent",
        port: 4000,
        mcpServers: {
          custom: { url: "http://localhost:5000" },
        },
      });

      const harness = ctx.plan.runtime.agentHarnesses[0];
      expect(harness.port).toBe(4000);
      expect(harness.mcpServers).toEqual({ custom: { url: "http://localhost:5000" } });

      const proc = ctx.plan.runtime.processes.find((p) => p.name === "opencode-agent-agent");
      expect(proc!.ports).toContainEqual({ host: 4000, container: 4000 });
    });

    it("rejects duplicate harness names", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addOpencodeHarness({ name: "agent" });
      expect(() => ctx.addOpencodeHarness({ name: "agent" })).toThrow(
        /Duplicate agent harness name/,
      );
    });
  });

  describe("addLlmProvider", () => {
    it("adds an LLM provider with options and models", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addLlmProvider({
        name: "lmstudio",
        npm: "@ai-sdk/openai-compatible",
        displayName: "LM Studio",
        options: {
          baseURL: "http://localhost:2877/v1",
          apiKey: { env: "LMSTUDIO_API_KEY" },
        },
        models: {
          "local-model": { name: "Local Model" },
        },
      });

      expect(ctx.plan.runtime.llmProviders).toHaveLength(1);
      const provider = ctx.plan.runtime.llmProviders[0];
      expect(provider.name).toBe("lmstudio");
      expect(provider.npm).toBe("@ai-sdk/openai-compatible");
      expect(provider.displayName).toBe("LM Studio");
      expect(provider.options).toEqual({
        baseURL: "http://localhost:2877/v1",
        apiKey: { env: "LMSTUDIO_API_KEY" },
      });
      expect(provider.models).toEqual({ "local-model": { name: "Local Model" } });
    });

    it("rejects duplicate LLM provider names", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addLlmProvider({ name: "lmstudio" });
      expect(() => ctx.addLlmProvider({ name: "lmstudio" })).toThrow(/Duplicate LLM provider name/);
    });

    it("rejects literal credential strings in options", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() =>
        ctx.addLlmProvider({
          name: "lmstudio",
          options: { apiKey: "sk-secret" },
        }),
      ).toThrow(/must be an environment reference/);
    });
  });

  describe("addPiHarness", () => {
    it("adds a Pi harness with defaults", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addPiHarness({ name: "coder" });

      expect(ctx.plan.runtime.piHarnesses).toHaveLength(1);
      const harness = ctx.plan.runtime.piHarnesses[0];
      expect(harness.name).toBe("coder");
      expect(harness.type).toBe("pi");
      expect(harness.telemetry.enabled).toBe(true);
      expect(harness.telemetry.path).toBe("/workspace/.biodome-build/logs/pi-coder-events.jsonl");
      expect(harness.telemetry.capturePayloads).toBe(false);

      expect(
        ctx.plan.build.languageSnippets.some((s) => s.includes("@earendil-works/pi-coding-agent")),
      ).toBe(true);
    });

    it("supports provider, model, tools and resources", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addPiHarness({
        name: "coder",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: { env: "ANTHROPIC_API_KEY" },
        tools: ["read", "bash", "edit", "write"],
        extensions: ["/workspace/ext.ts"],
        skills: ["/workspace/skills"],
        packages: ["pi-skills"],
      });

      const harness = ctx.plan.runtime.piHarnesses[0];
      expect(harness.provider).toBe("anthropic");
      expect(harness.model).toBe("claude-sonnet-4-20250514");
      expect(harness.tools).toEqual(["read", "bash", "edit", "write"]);
      expect(harness.extensions).toEqual(["/workspace/ext.ts"]);
      expect(harness.skills).toEqual(["/workspace/skills"]);
      expect(harness.packages).toEqual(["pi-skills"]);

      const envVar = ctx.plan.runtime.envVars.find((e) => e.key === "ANTHROPIC_API_KEY");
      expect(envVar).toBeDefined();
      expect(envVar!.from).toEqual({ env: "ANTHROPIC_API_KEY" });
    });

    it("rejects duplicate Pi harness names", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addPiHarness({ name: "coder" });
      expect(() => ctx.addPiHarness({ name: "coder" })).toThrow(/Duplicate Pi harness name/);
    });

    it("rejects literal apiKey strings", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() => ctx.addPiHarness({ name: "coder", apiKey: "sk-secret" })).toThrow(
        /must be an environment reference/,
      );
    });
  });

  describe("addCodexHarness", () => {
    it("adds a Codex harness with defaults", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.configureMcp(3001);
      ctx.addCodexHarness({ name: "coder" });

      expect(ctx.plan.runtime.codexHarnesses).toHaveLength(1);
      const harness = ctx.plan.runtime.codexHarnesses[0];
      expect(harness.name).toBe("coder");
      expect(harness.type).toBe("codex");
      expect(harness.port).toBe(3003);
      expect(harness.mcpServers).toEqual({ biodome: { url: "http://localhost:3001" } });
      expect(harness.telemetry.enabled).toBe(true);
      expect(harness.telemetry.path).toBe(
        "/workspace/.biodome-build/logs/codex-coder-events.jsonl",
      );
      expect(harness.telemetry.capturePayloads).toBe(false);

      const proc = ctx.plan.runtime.processes.find((p) => p.name === "codex-agent-coder");
      expect(proc).toBeDefined();
      expect(proc!.mode).toBe("daemon");
      expect(proc!.command).toContain("/workspace/.biodome-build/codex-homes/coder/start.sh");
      expect(proc!.environment!.HOME).toBe("/workspace/.biodome-build/codex-homes/coder");
      expect(proc!.mergeEnv).toBe(false);

      expect(ctx.plan.build.languageSnippets.some((s) => s.includes("@openai/codex"))).toBe(true);
    });

    it("supports custom port, model, and apiKey", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addCodexHarness({
        name: "coder",
        port: 4000,
        model: "gpt-5.6",
        apiKey: { env: "OPENAI_API_KEY" },
        mcpServers: { custom: { url: "http://localhost:5000" } },
      });

      const harness = ctx.plan.runtime.codexHarnesses[0];
      expect(harness.port).toBe(4000);
      expect(harness.model).toBe("gpt-5.6");
      expect(harness.mcpServers).toEqual({ custom: { url: "http://localhost:5000" } });

      const envVar = ctx.plan.runtime.envVars.find((e) => e.key === "OPENAI_API_KEY");
      expect(envVar).toBeDefined();
      expect(envVar!.from).toEqual({ env: "OPENAI_API_KEY" });
    });

    it("rejects duplicate Codex harness names", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addCodexHarness({ name: "coder" });
      expect(() => ctx.addCodexHarness({ name: "coder" })).toThrow(/Duplicate Codex harness name/);
    });

    it("rejects literal apiKey strings", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() => ctx.addCodexHarness({ name: "coder", apiKey: "sk-secret" })).toThrow(
        /must be an environment reference/,
      );
    });
  });

  describe("addClaudeHarness", () => {
    it("adds a Claude harness with defaults", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addClaudeHarness({ name: "assistant" });

      expect(ctx.plan.runtime.claudeHarnesses).toHaveLength(1);
      const harness = ctx.plan.runtime.claudeHarnesses[0];
      expect(harness.name).toBe("assistant");
      expect(harness.type).toBe("claude");
      expect(harness.telemetry.enabled).toBe(true);
      expect(harness.telemetry.path).toBe(
        "/workspace/.biodome-build/logs/claude-assistant-events.jsonl",
      );
      expect(harness.telemetry.capturePayloads).toBe(false);

      expect(
        ctx.plan.build.languageSnippets.some((s) => s.includes("@anthropic-ai/claude-code")),
      ).toBe(true);
    });

    it("supports model, tools, permissions, and apiKey", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addClaudeHarness({
        name: "assistant",
        model: "claude-sonnet-4-20250514",
        apiKey: { env: "ANTHROPIC_API_KEY" },
        tools: ["Bash", "Read", "Edit"],
        permissions: "acceptEdits",
      });

      const harness = ctx.plan.runtime.claudeHarnesses[0];
      expect(harness.model).toBe("claude-sonnet-4-20250514");
      expect(harness.tools).toEqual(["Bash", "Read", "Edit"]);
      expect(harness.permissions).toBe("acceptEdits");

      const envVar = ctx.plan.runtime.envVars.find((e) => e.key === "ANTHROPIC_API_KEY");
      expect(envVar).toBeDefined();
      expect(envVar!.from).toEqual({ env: "ANTHROPIC_API_KEY" });
    });

    it("rejects duplicate Claude harness names", () => {
      const ctx = new SandboxContext("/tmp", "test");
      ctx.addClaudeHarness({ name: "assistant" });
      expect(() => ctx.addClaudeHarness({ name: "assistant" })).toThrow(
        /Duplicate Claude harness name/,
      );
    });

    it("rejects literal apiKey strings", () => {
      const ctx = new SandboxContext("/tmp", "test");
      expect(() => ctx.addClaudeHarness({ name: "assistant", apiKey: "sk-secret" })).toThrow(
        /must be an environment reference/,
      );
    });
  });
});
