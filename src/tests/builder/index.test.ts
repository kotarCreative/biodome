import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildPlan,
  buildTargetPlan,
  buildTaskPlan,
  validateConfig,
  validateFeatures,
  validatePlan,
} from "../../builder/index.js";
import { generateCompose } from "../../docker/generators/compose.js";
import { generateDockerfile } from "../../docker/generators/dockerfile.js";

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
  it("rejects enabling MCP without an environment-backed token", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({
        project: { name: "mcp-invalid" },
        mcp: { enabled: true, port: 3100 },
      }),
      ".biodome/features/.gitkeep": "",
    });

    await expect(buildPlan(dir)).rejects.toThrow(
      "MCP requires an environment-backed token when enabled",
    );
  });

  it("rejects a literal MCP token string", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({
        project: { name: "mcp-invalid" },
        mcp: { enabled: true, token: "secret" },
      }),
      ".biodome/features/.gitkeep": "",
    });

    await expect(buildPlan(dir)).rejects.toThrow();
  });

  it("loads config and features", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "my-app" } }),
      ".biodome/services.mjs": `
        export default function services(ctx) {
          ctx.addService("postgres", { port: 5432 });
        }
      `,
      ".biodome/features/django.mjs": `
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
    expect(plan.runtime.processes).toHaveLength(3);
    expect(plan.runtime.services).toHaveLength(1);
    expect(plan.runtime.services[0].name).toBe("postgres");
  });

  it("still loads legacy .js feature files", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "legacy-app" } }),
      ".biodome/services.js": `
        export default function services(ctx) {
          ctx.addService("redis", { port: 6379 });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.runtime.services).toHaveLength(1);
    expect(plan.runtime.services[0].name).toBe("redis");
  });

  it("turns an AWS secret ARN service password into a passthrough env var", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:pg-AbCdEf";
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "arn-app" } }),
      ".biodome/services.mjs": `
        export default function services(ctx) {
          ctx.addService("postgres", {
            port: 5432,
            password: { secretArn: "${secretArn}" },
          });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.runtime.envVars).toEqual([
      { key: "POSTGRES_PASSWORD", scope: "runtime", from: { secretArn } },
    ]);
    // The credential value never lands in the literal environment.
    expect(plan.runtime.environment.POSTGRES_PASSWORD).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain('POSTGRES_PASSWORD":');
  });

  it("lets an AWS secret ARN-backed env var satisfy harness and provider references", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:key-AbCdEf";
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "arn-refs" } }),
      ".biodome/features/agents.mjs": `
        export default function agents(ctx) {
          ctx.addEnv("ANTHROPIC_API_KEY", { from: { secretArn: "${secretArn}" } });
          ctx.addClaudeHarness({ name: "assistant", apiKey: { env: "ANTHROPIC_API_KEY" } });
          ctx.addLlmProvider({
            name: "anthropic",
            options: { apiKey: { env: "ANTHROPIC_API_KEY" } },
            models: {},
          });
        }
      `,
    });

    // The harness and provider both desugar to env declarations for the same
    // variable; the user's ARN-backed declaration must win without conflict.
    const plan = await buildPlan(dir);
    expect(plan.runtime.envVars).toEqual([
      { key: "ANTHROPIC_API_KEY", scope: "runtime", from: { secretArn } },
    ]);
  });

  it("executes arbitrary commands in features", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "cmd-app" } }),
      ".biodome/features/env.mjs": `
        export default function env(ctx) {
          const result = ctx.exec("echo branch=main");
          ctx.addEnv("BRANCH", { value: result.stdout.trim().split("=")[1] });
        }
      `,
    });

    const plan = await buildPlan(dir);
    expect(plan.runtime.environment.BRANCH).toBe("main");
  });

  it("uses npm install when no lock file exists", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "node-app" } }),
      "package.json": JSON.stringify({ name: "node-app" }),
      ".biodome/features/node.mjs": `
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
      ".biodome/config.json": JSON.stringify({ project: { name: "node-app" } }),
      "package.json": JSON.stringify({ name: "node-app" }),
      "package-lock.json": JSON.stringify({}),
      ".biodome/features/node.mjs": `
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
      ".biodome/config.json": JSON.stringify({ project: { name: "py-app" } }),
      "requirements.txt": "django\n",
      ".biodome/features/python.mjs": `
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
      ".biodome/config.json": JSON.stringify({ project: { name: "fullstack-app" } }),
      "requirements.txt": "django\n",
      "package.json": JSON.stringify({ name: "frontend" }),
      "package-lock.json": JSON.stringify({}),
      ".biodome/features/python.mjs": `
        export default function python(ctx) {
          ctx.addLanguage("python", { version: "3.12" });
        }
      `,
      ".biodome/features/node.mjs": `
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
      ".biodome/config.json": JSON.stringify({ project: { name: "my-app" } }),
      ".biodome/features/dangerous.mjs": `
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
      ".biodome/config.json": JSON.stringify({ project: {} }),
    });

    expect(() => validateConfig(dir)).toThrow(/Missing key/);
  });

  it("throws a helpful error for non-object config", () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify("bad"),
    });

    expect(() => validateConfig(dir)).toThrow(/Expected object/);
  });
});

describe("validatePlan", () => {
  it("throws when a process and service share a host port", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "port-conflict" } }),
      ".biodome/services.mjs": `
        export default function services(ctx) {
          ctx.addService("postgres", { port: 5432 });
        }
      `,
      ".biodome/features/django.mjs": `
        export default function django(ctx) {
          ctx.addProcess({ name: "pg", command: ["node"], port: 5432 });
        }
      `,
    });

    await expect(buildPlan(dir)).rejects.toThrow(
      /Host port 5432 is used by both process "pg" and service "postgres"/,
    );
  });

  it("can be called directly on a valid plan", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "valid-plan" } }),
      ".biodome/features/web.mjs": `
        export default function web(ctx) {
          ctx.addProcess({ name: "app", command: ["node"], port: 3000 });
        }
      `,
    });

    const plan = await buildPlan(dir);
    await expect(Effect.runPromise(validatePlan(plan))).resolves.toBeUndefined();
  });

  it("rejects plans whose cloud volumes lack the direct-mount opt-in", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "unsafe-mount" } }),
      ".biodome/features/volumes.mjs": `
        export default function volumes(ctx) {
          ctx.addS3Volume({
            name: "assets",
            bucket: "example-assets",
            target: "/workspace/assets",
            credentials: { accessKeyId: { env: "AWS_ACCESS_KEY_ID" } },
          });
        }
      `,
    });

    await expect(buildPlan(dir)).rejects.toThrow(/directMount: true/);
  });

  it("scopes rclone mount credentials to the mount helper process only", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "scoped-creds" } }),
      ".biodome/features/volumes.mjs": `
        export default function volumes(ctx) {
          ctx.addS3Volume({
            name: "assets",
            bucket: "example-assets",
            target: "/workspace/assets",
            directMount: true,
            credentials: {
              accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
              secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
            },
          });
        }
      `,
    });

    const plan = await buildPlan(dir);
    const mount = plan.runtime.processes.find((process) => process.name === "rclone-mount-assets");
    expect(mount).toMatchObject({ mergeEnv: false, identity: "mount" });
    expect(mount?.command).not.toContain("--allow-other");
    // The credentials stay private to the mount helper's environment.
    expect(plan.runtime.environment).not.toHaveProperty("RCLONE_S3_SECRET_ACCESS_KEY");
    expect(mount?.environment.RCLONE_S3_SECRET_ACCESS_KEY).toBe("${AWS_SECRET_ACCESS_KEY}");
  });
});

describe("validateFeatures", () => {
  it("does not invoke default functions while checking exports", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    const marker = join(dir, "should-not-run");
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "my-app" } }),
      ".biodome/features/dangerous.mjs": `
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
      ".biodome/config.json": JSON.stringify({ project: { name: "ok-app" } }),
      ".biodome/services.mjs": `
        export default function services(ctx) {
          ctx.addService("redis", { port: 6379 });
        }
      `,
      ".biodome/features/node.mjs": `
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
      ".biodome/config.json": JSON.stringify({ project: { name: "bad-app" } }),
      ".biodome/features/incomplete.mjs": `
        export const notDefault = 42;
      `,
    });

    await expect(validateFeatures(dir)).rejects.toThrow(/must export a default function/);
  });

  it("rejects a services module whose default export is not a function", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "bad-app" } }),
      ".biodome/services.mjs": `
        export default 42;
      `,
    });

    await expect(validateFeatures(dir)).rejects.toThrow(/must export a default function/);
  });

  it("prefers services.mjs over services.js", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "legacy-app" } }),
      ".biodome/services.mjs": `
        export default function services() {}
      `,
      ".biodome/services.js": `
        export default "ignored";
      `,
    });

    await expect(validateFeatures(dir)).resolves.toBeDefined();
  });

  it("enables MCP when config has mcp.enabled", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({
        project: { name: "mcp-app" },
        mcp: { enabled: true, port: 3100, token: { env: "MCP_TOKEN" } },
      }),
      ".biodome/features/.gitkeep": "",
    });

    const plan = await buildPlan(dir);
    expect(plan.build.mcpEnabled).toBe(true);
    expect(plan.build.mcpPort).toBe(3100);

    const mcpProcess = plan.runtime.processes.find((p) => p.name === "biodome-mcp");
    expect(mcpProcess).toBeDefined();
    expect(mcpProcess!.ports[0].host).toBe(3100);

    // A Node runtime must be provisioned for the MCP server to run.
    expect(plan.build.languageRequests.some((r) => r.name === "node")).toBe(true);
    expect(plan.build.baseImage).toContain("node");

    // Dockerfile installs the SDK where the ESM server can resolve it.
    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("npm install --prefix / @modelcontextprotocol/sdk");

    // The MCP port is published on host loopback only.
    const compose = generateCompose(plan);
    expect(compose).toContain("127.0.0.1:3100:3100");
  });

  it("does not override an explicit node language request when MCP is enabled", async () => {
    const dir = join("/tmp", "sandbox-test-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({
        project: { name: "mcp-node-app" },
        mcp: { enabled: true, token: { env: "MCP_TOKEN" } },
      }),
      ".biodome/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "22", packageManager: "pnpm" });
        }
      `,
    });

    const plan = await buildPlan(dir);
    const node = plan.build.languageRequests.filter((r) => r.name === "node");
    expect(node).toHaveLength(1);
    expect(node[0].options.version).toBe("22");
    expect(node[0].options.packageManager).toBe("pnpm");
  });
});

describe("buildTargetPlan", () => {
  it("builds a plan with a target", async () => {
    const dir = join("/tmp", "sandbox-test-target-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "target-app" } }),
      ".biodome/features/.gitkeep": "",
      ".biodome/targets/local.mjs": `
        export default function local(ctx) {
          ctx.useRuntime("docker-compose");
        }
      `,
    });

    const plan = await buildTargetPlan(dir, "local");
    expect(plan.deployment).toBeDefined();
    expect(plan.deployment!.target.name).toBe("local");
    expect(plan.deployment!.target.driver).toBe("docker-compose");
    expect(plan.deployment!.deploymentId).toBeDefined();
    expect(plan.deployment!.deploymentId).toContain("target-app");
  });

  it("rebases generated process and harness paths to the target layout", async () => {
    const dir = join("/tmp", "sandbox-test-layout-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({
        project: { name: "layout-app" },
        mcp: { enabled: true, token: { env: "MCP_TOKEN" } },
      }),
      ".biodome/features/harnesses.mjs": `
        export default function harnesses(ctx) {
          ctx.addOpencodeHarness({ name: "open" });
          ctx.addPiHarness({ name: "pi" });
          ctx.addCodexHarness({ name: "codex" });
          ctx.addClaudeHarness({ name: "claude" });
        }
      `,
      ".biodome/targets/local.mjs": `
        export default function local(ctx) {
          ctx.useRuntime("docker-compose");
        }
      `,
    });

    const plan = await buildTargetPlan(dir, "local");
    const root = "/workspace/.biodome-build/targets/local";
    expect(plan.runtime.processes.flatMap((process) => process.command)).toEqual(
      expect.arrayContaining([`${root}/mcp/server.js`, `${root}/opencode-homes/open/start.sh`]),
    );
    expect(plan.runtime.agentHarnesses[0].telemetry.path).toBe(
      `${root}/logs/opencode-events.jsonl`,
    );
    expect(plan.runtime.piHarnesses[0].telemetry.path).toBe(`${root}/logs/pi-pi-events.jsonl`);
    expect(plan.runtime.codexHarnesses[0].telemetry.path).toBe(
      `${root}/logs/codex-codex-events.jsonl`,
    );
    expect(plan.runtime.claudeHarnesses[0].telemetry.path).toBe(
      `${root}/logs/claude-claude-events.jsonl`,
    );
  });

  it("fails when target file does not exist", async () => {
    const dir = join("/tmp", "sandbox-test-target-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "missing-target" } }),
      ".biodome/features/.gitkeep": "",
    });

    await expect(buildTargetPlan(dir, "nonexistent")).rejects.toThrow(/not found/);
  });

  it.each(["../../evil", "..\\..\\escape", ".", "..", "sub/dir/evil", ""])(
    "rejects target names that could traverse out of .biodome/targets (%s)",
    async (targetName) => {
      const dir = join("/tmp", "sandbox-test-target-" + Date.now());
      createProject(dir, {
        ".biodome/config.json": JSON.stringify({ project: { name: "traversal-target" } }),
        ".biodome/features/.gitkeep": "",
      });

      await expect(buildTargetPlan(dir, targetName)).rejects.toThrow(/Invalid target name/);
    },
  );

  it("fails when target module has no default export", async () => {
    const dir = join("/tmp", "sandbox-test-target-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "bad-target" } }),
      ".biodome/features/.gitkeep": "",
      ".biodome/targets/bad.mjs": `
        export const notTarget = 42;
      `,
    });

    await expect(buildTargetPlan(dir, "bad")).rejects.toThrow(/must export a default function/);
  });

  it("fails when target does not call useRuntime", async () => {
    const dir = join("/tmp", "sandbox-test-target-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "empty-target" } }),
      ".biodome/features/.gitkeep": "",
      ".biodome/targets/empty.mjs": `
        export default function empty(ctx) {
          // no useRuntime call
        }
      `,
    });

    await expect(buildTargetPlan(dir, "empty")).rejects.toThrow(/did not declare/);
  });

  it("fails when target declares an unknown runtime driver", async () => {
    const dir = join("/tmp", "sandbox-test-target-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "unknown-driver" } }),
      ".biodome/features/.gitkeep": "",
      ".biodome/targets/local.mjs": `
        export default function local(ctx) { ctx.useRuntime("not-a-driver"); }
      `,
    });

    await expect(buildTargetPlan(dir, "local")).rejects.toThrow(/Unknown runtime driver/);
  });

  it("fails with ambiguous .mjs and .js", async () => {
    const dir = join("/tmp", "sandbox-test-target-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "amb-target" } }),
      ".biodome/features/.gitkeep": "",
      ".biodome/targets/amb.mjs": `
        export default function amb(ctx) { ctx.useRuntime("docker-compose"); }
      `,
      ".biodome/targets/amb.js": `
        export default function amb(ctx) { ctx.useRuntime("docker-compose"); }
      `,
    });

    await expect(buildTargetPlan(dir, "amb")).rejects.toThrow(/Ambiguous/);
  });

  it("prefers .mjs over .js", async () => {
    const dir = join("/tmp", "sandbox-test-target-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "pref-target" } }),
      ".biodome/features/.gitkeep": "",
      ".biodome/targets/preferred.mjs": `
        export default function t(ctx) { ctx.useRuntime("docker-compose", { from: "mjs" }); }
      `,
    });

    const plan = await buildTargetPlan(dir, "preferred");
    expect(plan.deployment!.target.options).toEqual({ from: "mjs" });
  });
});

describe("buildTaskPlan", () => {
  it("builds a plan with target and task", async () => {
    const dir = join("/tmp", "sandbox-test-task-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "task-app" } }),
      ".biodome/features/.gitkeep": "",
      ".biodome/targets/local.mjs": `
        export default function t(ctx) { ctx.useRuntime("docker-compose"); }
      `,
      ".biodome/tasks/review.mjs": `
        export default function r(ctx) { ctx.addTask({ harness: "reviewer", prompt: "Review" }); }
      `,
    });

    await expect(buildTaskPlan(dir, "local", "review")).rejects.toThrow(
      /harness.*reviewer.*not declared/,
    );
  });

  it("fails when task file does not exist", async () => {
    const dir = join("/tmp", "sandbox-test-task-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "task-app" } }),
      ".biodome/features/.gitkeep": "",
      ".biodome/targets/local.mjs": `
        export default function t(ctx) { ctx.useRuntime("docker-compose"); }
      `,
    });

    await expect(buildTaskPlan(dir, "local", "nonexistent")).rejects.toThrow(/not found/);
  });

  it.each(["../../../../tmp/evil", "..\\..\\..\\escape", ".", "..", "sub/dir/evil", ""])(
    "rejects task names that could traverse out of .biodome/tasks (%s)",
    async (taskName) => {
      const dir = join("/tmp", "sandbox-test-task-" + Date.now());
      createProject(dir, {
        ".biodome/config.json": JSON.stringify({ project: { name: "task-traversal" } }),
        ".biodome/features/.gitkeep": "",
        ".biodome/targets/local.mjs": `
        export default function t(ctx) { ctx.useRuntime("docker-compose"); }
      `,
      });

      await expect(buildTaskPlan(dir, "local", taskName)).rejects.toThrow(/Invalid task name/);
    },
  );

  it("accepts task names containing dots, dashes, and underscores", async () => {
    const dir = join("/tmp", "sandbox-test-task-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "task-app" } }),
      ".biodome/features/codex.mjs": `
        export default function c(ctx) {
          ctx.addCodexHarness({ name: "coder", apiKey: { env: "TEST_KEY" }, mcpServers: {} });
        }
      `,
      ".biodome/targets/local.mjs": `
        export default function t(ctx) { ctx.useRuntime("docker-compose"); }
      `,
      ".biodome/tasks/review_step-1.2.mjs": `
        export default function r(ctx) { ctx.addTask({ harness: "coder", prompt: "Review" }); }
      `,
    });

    const plan = await buildTaskPlan(dir, "local", "review_step-1.2");
    expect(plan.deployment?.task?.harness).toBe("coder");
  });

  it("succeeds when harness exists", async () => {
    const dir = join("/tmp", "sandbox-test-task-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "task-app" } }),
      ".biodome/features/codex.mjs": `
        export default function c(ctx) {
          ctx.addCodexHarness({ name: "coder", apiKey: { env: "TEST_KEY" }, mcpServers: {} });
        }
      `,
      ".biodome/targets/local.mjs": `
        export default function t(ctx) { ctx.useRuntime("docker-compose"); }
      `,
      ".biodome/tasks/review.mjs": `
        export default function r(ctx) { ctx.addTask({ harness: "coder", prompt: "Review the code", cleanup: "always" }); }
      `,
    });

    const plan = await buildTaskPlan(dir, "local", "review");
    expect(plan.deployment).toBeDefined();
    expect(plan.deployment!.task).toBeDefined();
    expect(plan.deployment!.task!.harness).toBe("coder");
    expect(plan.deployment!.task!.prompt).toBe("Review the code");
    expect(plan.deployment!.task!.cleanup).toBe("always");
  });
});
