import { describe, expect, it } from "vitest";
import { generateCompose } from "../../../docker/generators/compose.js";
import {
  MCP_RUNTIME_FILES,
  renderCommonArtifacts,
  type GeneratedFile,
} from "../../../runtime/artifacts.js";
import { runtimeLayout } from "../../../runtime/layout.js";
import { createPlan, type Plan } from "../../../core/plan.js";

function completePlan(): Plan {
  const plan = createPlan("complete");
  plan.deployment = {
    target: { name: "local", driver: "docker-compose", options: {} },
    deploymentId: "complete-local",
  };
  plan.build.baseImage = "node:20-slim";
  plan.build.aptPackages = ["curl"];
  plan.build.nodeModulesVolume = true;
  plan.build.mcpEnabled = true;
  plan.build.mcpPort = 3001;
  plan.build.environment = { LOG_LEVEL: "info" };
  plan.runtime.envVars.push(
    { key: "DATABASE_URL", scope: "runtime", from: { env: "DATABASE_URL" }, required: true },
    { key: "PORT", scope: "runtime", from: { env: "PORT" }, default: "8000" },
  );
  plan.runtime.services.push({
    name: "postgres",
    type: "postgres",
    environment: { POSTGRES_USER: "app" },
    ports: [{ host: 5432, container: 5432 }],
  });
  plan.runtime.volumes.push({
    name: "data",
    type: "local",
    source: "./data",
    target: "/workspace/data",
  });
  plan.runtime.processes.push({
    name: "web",
    command: ["node", "server.js"],
    ports: [{ host: 3000, container: 3000 }],
    environment: { NODE_ENV: "production" },
    mode: "daemon",
    startOn: "start.post",
    healthCheck: {
      type: "http",
      url: "http://localhost:3000/health",
      interval: "5s",
      timeout: "3s",
      retries: 10,
    },
  });
  plan.runtime.repos.push({
    name: "backend",
    url: "https://github.com/acme/backend.git",
    path: "/workspace/repos/backend",
    branch: "main",
  });
  plan.runtime.agentHarnesses.push({
    name: "agent",
    type: "opencode",
    port: 3002,
    mcpServers: { biodome: { url: "http://localhost:3001" } },
    telemetry: {
      enabled: true,
      path: "/workspace/.biodome-build/targets/local/logs/opencode-events.jsonl",
    },
    config: {},
  });
  plan.runtime.piHarnesses.push({
    name: "coder",
    type: "pi",
    provider: "anthropic",
    telemetry: {
      enabled: true,
      path: "/workspace/.biodome-build/targets/local/logs/pi-coder-events.jsonl",
    },
    config: {},
  });
  plan.runtime.codexHarnesses.push({
    name: "codex",
    type: "codex",
    port: 3003,
    mcpServers: { biodome: { url: "http://localhost:3001" } },
    telemetry: {
      enabled: true,
      path: "/workspace/.biodome-build/targets/local/logs/codex-codex-events.jsonl",
    },
    config: {},
  });
  plan.runtime.claudeHarnesses.push({
    name: "claude",
    type: "claude",
    telemetry: {
      enabled: true,
      path: "/workspace/.biodome-build/targets/local/logs/claude-claude-events.jsonl",
    },
    config: {},
  });
  return plan;
}

function byPath(files: readonly GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((candidate) => candidate.relativePath === path);
  expect(file, `missing artifact ${path}`).toBeDefined();
  return file as GeneratedFile;
}

describe("complete-plan artifact regression", () => {
  it("renders the common manifest and Compose artifact with exact paths, modes, and content", () => {
    const plan = completePlan();
    const layout = runtimeLayout("/project", "local");
    const files = renderCommonArtifacts(plan, layout);

    // Deterministic ordering of the common manifest.
    const expectedOrder = files.map((file) => file.relativePath).sort((a, b) => a.localeCompare(b));
    expect(files.map((file) => file.relativePath)).toEqual(expectedOrder);

    // Dockerfile: target-scoped copy + lifecycle startup command for daemon processes.
    const dockerfile = byPath(files, ".biodome-build/targets/local/Dockerfile");
    expect(dockerfile.content).toContain(
      "COPY .biodome-build/targets/local/ /workspace/.biodome-build/targets/local/",
    );
    expect(dockerfile.content).toContain(
      'CMD ["sh", "/workspace/.biodome-build/targets/local/startup.sh"]',
    );
    expect(dockerfile.content).toContain("@modelcontextprotocol/sdk");

    // .dockerignore is created only when the project does not own one.
    const dockerignore = byPath(files, ".dockerignore");
    expect(dockerignore.writeMode).toBe("if-absent");
    expect(dockerignore.content).toContain("!.biodome-build/targets/**");

    // supervisord config declares the daemon and its healthcheck program.
    const supervisord = byPath(files, ".biodome-build/targets/local/supervisord.conf");
    expect(supervisord.content).toContain("[program:web]");
    expect(supervisord.content).toContain(
      "sh /workspace/.biodome-build/targets/local/healthchecks/web-monitor.sh",
    );
    expect(byPath(files, ".biodome-build/targets/local/startup.sh").mode).toBe(0o755);

    // Health-check scripts are executable shell scripts.
    const healthCheck = byPath(files, ".biodome-build/targets/local/healthchecks/web.sh");
    expect(healthCheck.mode).toBe(0o755);
    expect(healthCheck.content).toContain("curl -fsS --max-time 3 'http://localhost:3000/health'");
    const monitor = byPath(files, ".biodome-build/targets/local/healthchecks/web-monitor.sh");
    expect(monitor.mode).toBe(0o755);
    expect(monitor.content).toContain(
      "supervisorctl -c /workspace/.biodome-build/targets/local/supervisord.conf restart web",
    );
    const aggregate = byPath(files, ".biodome-build/targets/local/healthchecks/all.sh");
    expect(aggregate.mode).toBe(0o755);
    expect(aggregate.content).toContain(
      "sh /workspace/.biodome-build/targets/local/healthchecks/web.sh",
    );

    // Repository sync script is executable.
    const repo = byPath(files, ".biodome-build/targets/local/repos/backend.sh");
    expect(repo.mode).toBe(0o755);
    expect(repo.content).toContain("git clone --branch main 'https://github.com/acme/backend.git'");

    // Shared telemetry writer is emitted once and referenced by every family.
    const writer = byPath(files, ".biodome-build/targets/local/telemetry/writer.cjs");
    expect(writer.content).toContain("module.exports = { write }");

    // OpenCode family: config, plugin, start, task.
    const opencodeConfig = byPath(
      files,
      ".biodome-build/targets/local/opencode-homes/agent/.config/opencode/opencode.json",
    );
    expect(opencodeConfig.content).toContain('"plugins/agent-telemetry.js"');
    expect(
      byPath(
        files,
        ".biodome-build/targets/local/opencode-homes/agent/.config/opencode/plugins/agent-telemetry.js",
      ).content,
    ).toContain("source: 'opencode'");
    expect(
      byPath(files, ".biodome-build/targets/local/opencode-homes/agent/start.sh").content,
    ).toContain("exec opencode serve --port 3002");
    expect(
      byPath(files, ".biodome-build/targets/local/opencode-homes/agent/task").content,
    ).toContain("opencode run");

    // Pi family: settings, wrapper, task, telemetry extension.
    const piSettings = byPath(files, ".biodome-build/targets/local/pi-homes/coder/settings.json");
    expect(piSettings.content).toContain('"defaultProvider": "anthropic"');
    expect(byPath(files, ".biodome-build/targets/local/pi-homes/coder/pi").content).toContain(
      "exec pi",
    );
    expect(byPath(files, ".biodome-build/targets/local/pi-homes/coder/task").content).toContain(
      "pi -p",
    );
    expect(
      byPath(files, ".biodome-build/targets/local/pi-homes/coder/extensions/biodome-telemetry.ts")
        .content,
    ).toContain("source: 'pi'");

    // Codex family: config, hooks, telemetry, start, task.
    expect(
      byPath(files, ".biodome-build/targets/local/codex-homes/codex/.codex/config.toml").content,
    ).toContain("[mcp_servers.biodome]");
    expect(
      byPath(files, ".biodome-build/targets/local/codex-homes/codex/.codex/hooks.json").content,
    ).toContain("session_start");
    expect(
      byPath(files, ".biodome-build/targets/local/codex-homes/codex/hooks/telemetry.js").content,
    ).toContain("source: 'codex'");
    expect(
      byPath(files, ".biodome-build/targets/local/codex-homes/codex/start.sh").content,
    ).toContain("exec-server --listen ws://0.0.0.0:3003");
    expect(byPath(files, ".biodome-build/targets/local/codex-homes/codex/task").content).toContain(
      "codex -p",
    );

    // Claude family: settings, mcp config, telemetry, wrapper, task.
    expect(
      byPath(files, ".biodome-build/targets/local/claude-homes/claude/.claude/settings.json")
        .content,
    ).toContain("session_start");
    expect(
      byPath(files, ".biodome-build/targets/local/claude-homes/claude/.claude.json").content,
    ).toContain("http://localhost:3001");
    expect(
      byPath(files, ".biodome-build/targets/local/claude-homes/claude/hooks/telemetry.js").content,
    ).toContain("source: 'claude'");
    expect(
      byPath(files, ".biodome-build/targets/local/claude-homes/claude/claude").content,
    ).toContain("exec claude");
    expect(
      byPath(files, ".biodome-build/targets/local/claude-homes/claude/task").content,
    ).toContain("claude -p");

    // MCP plan + full runtime tree are copied from source paths.
    const mcpPlan = byPath(files, ".biodome-build/targets/local/plan.json");
    expect(mcpPlan.content).toContain('"project"');
    for (const runtimeFile of MCP_RUNTIME_FILES) {
      const mcpFile = byPath(files, `.biodome-build/targets/local/${runtimeFile}`);
      expect(mcpFile.sourcePath).toBeDefined();
      expect(mcpFile.content).toBeUndefined();
    }

    // Compose artifact: a single dev service (backing services run in-container)
    // with ports, health check, volumes, and passthrough interpolation that
    // never bakes secrets into the image.
    const compose = generateCompose(plan, {
      buildContext: "../..",
      dockerfile: ".biodome-build/targets/local/Dockerfile",
      workspace: "../..",
    });
    expect(compose).toContain("complete-dev:latest");
    expect(compose).toContain("3000:3000");
    expect(compose).toContain("5432:5432");
    expect(compose).toContain("sh /workspace/.biodome-build/targets/local/healthchecks/all.sh");
    expect(compose).toContain("./data:/workspace/data");
    expect(compose).toContain("node_modules:/workspace/node_modules");
    expect(compose).toContain("${DATABASE_URL:?DATABASE_URL is required by DATABASE_URL}");
    expect(compose).toContain("${PORT:-8000}");
    // Exactly one compose service: the dev image hosts everything.
    expect(compose).toMatch(/services:\n  dev:\n/);
    expect(compose).not.toContain("postgres:16-alpine");
    expect(compose).not.toContain("depends_on");
  });
});
