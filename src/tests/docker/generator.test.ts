import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateDockerfile,
  generateSupervisordConf,
  generateCompose,
  generateDockerignore,
  generateHealthcheckScripts,
  generateRepoScripts,
  generateHarnessFiles,
  generatePiHarnessFiles,
  generateCodexHarnessFiles,
  generateClaudeHarnessFiles,
} from "../../docker/generator.js";
import { createPlan } from "../../core/plan.js";

describe("Docker generators", () => {
  it("uses target-specific Compose paths when provided", () => {
    const compose = generateCompose(createPlan("my-app"), {
      buildContext: "../../..",
      dockerfile: ".biodome-build/targets/local/Dockerfile",
      workspace: "../../..",
    });

    expect(compose).toContain("context: ../../..");
    expect(compose).toContain("dockerfile: .biodome-build/targets/local/Dockerfile");
    expect(compose).toContain("- ../../..:/workspace");
  });

  it("installs the AWS CLI for ECS artifact uploads", () => {
    const plan = createPlan("my-app");
    plan.deployment = {
      target: {
        name: "remote",
        driver: "aws-ecs",
        options: { artifactBucket: "task-artifacts" },
      },
      deploymentId: "my-app-remote",
    };

    expect(generateDockerfile(plan)).toContain("awscli");
  });

  it("generates a Dockerfile with supervisord for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.build.baseImage = "python:3.12-slim";
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("FROM python:3.12-slim AS base");
    expect(dockerfile).toContain("supervisor");
    expect(dockerfile).toContain("supervisord.conf");
    expect(dockerfile).toContain(
      'CMD ["supervisord", "-c", "/workspace/.biodome-build/supervisord.conf"]',
    );
    expect(dockerfile).not.toContain('CMD ["bash"]');
  });

  it("generates supervisord.conf for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("[program:django]");
    expect(conf).toContain("command=python manage.py runserver 0.0.0.0:8000");
    expect(conf).toContain("[supervisord]");
  });

  it("generates supervisord healthcheck programs and RPC config", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:8000/admin/login/",
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("[unix_http_server]");
    expect(conf).toContain("[supervisorctl]");
    expect(conf).toContain("[rpcinterface:supervisor]");
    expect(conf).toContain("[program:django-healthcheck]");
    expect(conf).toContain("sh /workspace/.biodome-build/healthchecks/django-monitor.sh");
  });

  it("does not include bash CMD when no daemon processes exist", () => {
    const plan = createPlan("my-app");
    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain('CMD ["bash"]');
  });

  it("copies target-scoped generated files for image-only runtimes", () => {
    const dockerfile = generateDockerfile(createPlan("my-app"), {
      generatedFilesPath: ".biodome-build/targets/staging",
    });

    expect(dockerfile).toContain("COPY .biodome-build/targets/staging/ /workspace/.biodome-build/");
  });

  it("keeps target-scoped generated files in the Docker build context", () => {
    const dockerignore = generateDockerignore();

    expect(dockerignore).toContain("!.biodome-build/targets");
    expect(dockerignore).toContain("!.biodome-build/targets/**");
  });

  it("generates compose with ports and no sleep infinity for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:8000/admin/login/",
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("8000:8000");
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("sh /workspace/.biodome-build/healthchecks/all.sh");
    expect(compose).not.toContain("sleep infinity");
    expect(compose).toContain("..:/workspace");

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["django.sh"]).toContain("curl -fsS");
    expect(healthchecks["django.sh"]).toContain("http://localhost:8000/admin/login/");
    expect(healthchecks["django-monitor.sh"]).toContain("supervisorctl");
    expect(healthchecks["all.sh"]).toContain("sh /workspace/.biodome-build/healthchecks/django.sh");
  });

  it("bakes literal env vars into the Dockerfile and compose", () => {
    const plan = createPlan("my-app");
    plan.build.environment.DEBUG = "1";
    plan.runtime.environment.DEBUG = "1";
    plan.runtime.envVars.push({ key: "DEBUG", scope: "both", value: "1" });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("DEBUG=1");

    const compose = generateCompose(plan);
    expect(compose).toContain('DEBUG: "1"');
  });

  it("emits passthrough env vars as compose interpolations, not literals", () => {
    const plan = createPlan("my-app");
    plan.runtime.envVars.push(
      { key: "DATABASE_URL", scope: "runtime", from: { env: "DATABASE_URL" }, required: true },
      { key: "PORT", scope: "runtime", from: { env: "PORT" }, default: "8000" },
      { key: "API_KEY", scope: "runtime", from: { env: "API_KEY" } },
    );

    const compose = generateCompose(plan);
    // Required -> fails compose if unset.
    expect(compose).toContain("${DATABASE_URL:?DATABASE_URL is required by DATABASE_URL}");
    // Default -> falls back.
    expect(compose).toContain("${PORT:-8000}");
    // Plain passthrough.
    expect(compose).toContain("${API_KEY}");

    // Secrets are never baked into the image.
    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).not.toContain("DATABASE_URL");
    expect(dockerfile).not.toContain("API_KEY");
  });

  it("keeps build-scoped passthrough vars out of the runtime compose env", () => {
    const plan = createPlan("my-app");
    plan.runtime.envVars.push({
      key: "BUILD_TOKEN",
      scope: "build",
      from: { env: "BUILD_TOKEN" },
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("BUILD_TOKEN");
  });

  it("generates health check scripts with timeout in seconds", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "web",
      command: ["node", "server.js"],
      ports: [{ host: 3000, container: 3000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:3000/health",
        timeout: "2s",
      },
    });

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["web.sh"]).toContain("curl -fsS --max-time 2");
  });

  it("quotes exec health check commands for the shell", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "custom",
      command: ["node", "server.js"],
      ports: [{ host: 3000, container: 3000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "exec",
        command: ["sh", "-c", "curl -f http://localhost/"],
      },
    });

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["custom.sh"]).toContain("sh -c 'curl -f http://localhost/'");
  });

  it("generates a .dockerignore that excludes .biodome but keeps supervisord.conf", () => {
    const dockerignore = generateDockerignore();
    expect(dockerignore).toContain(".biodome-build/*");
    expect(dockerignore).toContain("!.biodome-build/supervisord.conf");
    expect(dockerignore).not.toContain(".biodome-build\n");
  });

  it("adds local bind mounts to the dev service", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("./data:/workspace/data");
  });

  it("adds read-only local bind mounts", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
      readOnly: true,
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("./data:/workspace/data:ro");
  });

  it("declares named local volumes in the compose volumes section", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "shared",
      type: "local",
      source: "shared-data",
      target: "/workspace/shared",
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("shared-data:/workspace/shared");
    expect(compose).toContain("volumes:\n  shared-data:");
  });

  it("adds FUSE capabilities for cloud-backed volumes instead of privileged mode", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "s3-data",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-data",
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("privileged:");
    expect(compose).toContain("/dev/fuse");
    expect(compose).toContain("SYS_ADMIN");
    expect(compose).toContain("no-new-privileges");
  });

  it("does not add FUSE devices for local volumes only", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("privileged");
    expect(compose).not.toContain("/dev/fuse");
  });

  it("does not add FUSE devices when all cloud volumes are proxy volumes", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "s3-proxy",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-proxy",
      proxy: true,
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("privileged");
    expect(compose).not.toContain("/dev/fuse");
    expect(compose).not.toContain("/workspace/s3-proxy");
  });

  it("installs only the provider SDKs needed by proxy volumes in the Dockerfile", () => {
    const plan = createPlan("my-app");
    plan.build.mcpEnabled = true;
    plan.runtime.volumes.push({
      name: "s3-proxy",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-proxy",
      proxy: true,
    });
    plan.runtime.volumes.push({
      name: "azure-proxy",
      type: "azure",
      account: "myaccount",
      container: "mycontainer",
      target: "/workspace/azure-proxy",
      proxy: true,
    });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("@aws-sdk/client-s3");
    expect(dockerfile).toContain("@azure/storage-blob");
    expect(dockerfile).not.toContain("@google-cloud/storage");
  });

  it("does not install provider SDKs when no proxy volumes exist", () => {
    const plan = createPlan("my-app");
    plan.build.mcpEnabled = true;

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("@modelcontextprotocol/sdk");
    expect(dockerfile).not.toContain("@aws-sdk/client-s3");
    expect(dockerfile).not.toContain("@google-cloud/storage");
    expect(dockerfile).not.toContain("@azure/storage-blob");
  });

  it("does not mount local proxy volumes in the dev service", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "local-proxy",
      type: "local",
      source: "./data",
      target: "/workspace/data",
      proxy: true,
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("./data:/workspace/data");
  });

  describe("generateRepoScripts", () => {
    it("generates a clone script for a new repo", () => {
      const plan = createPlan("my-app");
      plan.runtime.repos.push({
        name: "backend",
        url: "https://github.com/acme/backend.git",
        path: "/workspace/repos/backend",
        branch: "main",
      });

      const scripts = generateRepoScripts(plan);
      const script = scripts["backend.sh"];
      expect(script).toContain("#!/bin/sh");
      expect(script).toContain("REPO_DIR=/workspace/repos/backend");
      expect(script).toContain(
        'git clone --branch main https://github.com/acme/backend.git "$REPO_DIR"',
      );
      expect(script).toContain("git pull origin main");
    });

    it("includes a depth flag when configured", () => {
      const plan = createPlan("my-app");
      plan.runtime.repos.push({
        name: "backend",
        url: "https://github.com/acme/backend.git",
        path: "/workspace/repos/backend",
        branch: "main",
        depth: 1,
      });

      const scripts = generateRepoScripts(plan);
      expect(scripts["backend.sh"]).toContain(
        "git clone --branch main --depth 1 https://github.com/acme/backend.git",
      );
    });

    it("injects a token into an https url", () => {
      const plan = createPlan("my-app");
      plan.runtime.repos.push({
        name: "backend",
        url: "https://github.com/acme/backend.git",
        path: "/workspace/repos/backend",
        branch: "main",
        credentials: { token: { env: "GITHUB_TOKEN" } },
      });

      const scripts = generateRepoScripts(plan);
      expect(scripts["backend.sh"]).toContain('if [ -z "$GITHUB_TOKEN" ]');
      expect(scripts["backend.sh"]).toContain("https://$GITHUB_TOKEN@github.com/acme/backend.git");
    });

    it("configures an ssh key for git over ssh", () => {
      const plan = createPlan("my-app");
      plan.runtime.repos.push({
        name: "backend",
        url: "git@github.com:acme/backend.git",
        path: "/workspace/repos/backend",
        branch: "main",
        credentials: { sshKey: { env: "BACKEND_SSH_KEY" } },
      });

      const scripts = generateRepoScripts(plan);
      expect(scripts["backend.sh"]).toContain('if [ -z "$BACKEND_SSH_KEY" ]');
      expect(scripts["backend.sh"]).toContain("/tmp/biodome-repo-keys/backend");
      expect(scripts["backend.sh"]).toContain("GIT_SSH_COMMAND");
    });
  });

  describe("generateHarnessFiles", () => {
    it("generates opencode config and telemetry plugin", () => {
      const plan = createPlan("my-app");
      plan.runtime.agentHarnesses.push({
        name: "agent",
        type: "opencode",
        port: 3002,
        mcpServers: { biodome: { url: "http://localhost:3001" } },
        telemetry: { enabled: true, path: "/workspace/.biodome-build/logs/opencode-events.jsonl" },
        config: {},
      });

      const files = generateHarnessFiles(plan);
      const configPath = "opencode-homes/agent/.config/opencode/opencode.json";
      const pluginPath = "opencode-homes/agent/.config/opencode/plugins/agent-telemetry.js";
      const startPath = "opencode-homes/agent/start.sh";

      expect(files[configPath]).toContain('"$schema": "https://opencode.ai/config.json"');
      expect(files[configPath]).toContain('"mcp"');
      expect(files[configPath]).toContain('"biodome"');
      expect(files[configPath]).toContain('"type": "remote"');
      expect(files[configPath]).toContain("http://localhost:3001");
      expect(files[configPath]).toContain("plugins/agent-telemetry.js");

      const plugin = files[pluginPath];
      expect(plugin).toContain("export default async () =>");
      expect(plugin).toContain("tool.execute.before");
      expect(plugin).toContain("tool.execute.after");
      expect(plugin).toContain("chat.message");
      expect(plugin).toContain("/workspace/.biodome-build/logs/opencode-events.jsonl");
      expect(plugin).toContain("const CAPTURE_PAYLOADS = false");

      expect(files[startPath]).toContain("#!/bin/sh");
      expect(files[startPath]).toContain("opencode serve");
      expect(files[startPath]).toContain("3002");

      const taskPath = "opencode-homes/agent/task";
      expect(files[taskPath]).toBeDefined();
      expect(files[taskPath]).toContain("#!/bin/sh");
      expect(files[taskPath]).toContain("opencode run");
      expect(files[taskPath]).toContain("/workspace/.biodome-build/opencode-homes/agent");
      expect(files[taskPath]).toContain("BIODOME_ARTIFACT_PATHS");
      expect(files[taskPath]).toContain("aws s3 cp");
    });

    it("uses the target-scoped home in the OpenCode task wrapper", () => {
      const plan = createPlan("test");
      plan.runtime.agentHarnesses.push({
        name: "agent",
        type: "opencode",
        port: 3002,
        mcpServers: {},
        telemetry: { enabled: true, path: "/workspace/.biodome-build/logs/opencode-events.jsonl" },
        config: {},
      });
      plan.deployment = {
        target: { name: "local", driver: "docker-compose", options: {} },
        deploymentId: "test-local",
      };

      const task = generateHarnessFiles(plan)["opencode-homes/agent/task"];
      expect(task).toContain("/workspace/.biodome-build/targets/local/opencode-homes/agent");
      expect(task).toContain("opencode run");
    });

    it("renders LLM providers into the OpenCode config", () => {
      const plan = createPlan("test");
      plan.runtime.agentHarnesses.push({
        name: "agent",
        type: "opencode",
        port: 3002,
        mcpServers: {},
        telemetry: { enabled: true, path: "/workspace/.biodome-build/logs/opencode-events.jsonl" },
        config: {},
      });
      plan.runtime.llmProviders.push({
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

      const files = generateHarnessFiles(plan);
      const config = JSON.parse(files["opencode-homes/agent/.config/opencode/opencode.json"]);
      expect(config.provider).toBeDefined();
      expect(config.provider.lmstudio).toEqual({
        npm: "@ai-sdk/openai-compatible",
        name: "LM Studio",
        options: {
          baseURL: "http://localhost:2877/v1",
          apiKey: "${LMSTUDIO_API_KEY}",
        },
        models: { "local-model": { name: "Local Model" } },
      });
    });
  });

  describe("generatePiHarnessFiles", () => {
    it("uses the target-scoped home in generated task wrappers", () => {
      const plan = createPlan("test");
      plan.runtime.piHarnesses.push({
        name: "coder",
        type: "pi",
        telemetry: { enabled: false, path: "" },
        config: {},
      });
      plan.deployment = {
        target: { name: "local", driver: "docker-compose", options: {} },
        deploymentId: "test-local",
      };

      const task = generatePiHarnessFiles(plan)["pi-homes/coder/task"];
      expect(task).toContain(
        "PI_CODING_AGENT_DIR=/workspace/.biodome-build/targets/local/pi-homes/coder",
      );
    });

    it("generates Pi settings, wrapper script, and telemetry extension", () => {
      const plan = createPlan("test");
      plan.runtime.piHarnesses.push({
        name: "coder",
        type: "pi",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: { env: "ANTHROPIC_API_KEY" },
        tools: ["read", "bash", "edit", "write"],
        telemetry: { enabled: true, path: "/workspace/.biodome-build/logs/pi-coder-events.jsonl" },
        config: {},
      });

      const files = generatePiHarnessFiles(plan);
      expect(files["pi-homes/coder/settings.json"]).toContain('"defaultProvider": "anthropic"');
      expect(files["pi-homes/coder/settings.json"]).toContain(
        '"defaultModel": "claude-sonnet-4-20250514"',
      );
      expect(files["pi-homes/coder/settings.json"]).toContain('"extensions"');

      const wrapper = files["pi-homes/coder/pi"];
      expect(wrapper).toContain("#!/bin/sh");
      expect(wrapper).toContain("PI_CODING_AGENT_DIR=/workspace/.biodome-build/pi-homes/coder");
      expect(wrapper).toContain('ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"');
      expect(wrapper).toContain("--tools read,bash,edit,write");

      const task = files["pi-homes/coder/task"];
      expect(task).toContain("#!/bin/sh");
      expect(task).toContain("PI_CODING_AGENT_DIR=/workspace/.biodome-build/pi-homes/coder");
      expect(task).toContain('pi -p "$@"');
      expect(task).toContain("aws s3 cp");

      const telemetry = files["pi-homes/coder/extensions/biodome-telemetry.ts"];
      expect(telemetry).toContain("export default function (pi)");
      expect(telemetry).toContain("agent_start");
      expect(telemetry).toContain("tool_execution_start");
      expect(telemetry).toContain("const CAPTURE_PAYLOADS = false");
    });

    it("omits telemetry extension when disabled", () => {
      const plan = createPlan("test");
      plan.runtime.piHarnesses.push({
        name: "coder",
        type: "pi",
        telemetry: { enabled: false, path: "" },
        config: {},
      });

      const files = generatePiHarnessFiles(plan);
      expect(files["pi-homes/coder/extensions/biodome-telemetry.ts"]).toBeUndefined();
    });
  });

  describe("generateCodexHarnessFiles", () => {
    it("generates Codex config, hooks, telemetry script, and start script", () => {
      const plan = createPlan("test");
      plan.build.mcpPort = 3001;
      plan.runtime.codexHarnesses.push({
        name: "coder",
        type: "codex",
        port: 3003,
        mcpServers: { biodome: { url: "http://localhost:3001" } },
        model: "gpt-5.6",
        telemetry: {
          enabled: true,
          path: "/workspace/.biodome-build/logs/codex-coder-events.jsonl",
        },
        config: {},
      });

      const files = generateCodexHarnessFiles(plan);
      const config = files["codex-homes/coder/.codex/config.toml"];
      expect(config).toContain("# Auto-generated Codex config for biodome");
      expect(config).toContain('model = "gpt-5.6"');
      expect(config).toContain("[mcp_servers.biodome]");
      expect(config).toContain('url = "http://localhost:3001"');

      const hooks = JSON.parse(files["codex-homes/coder/.codex/hooks.json"]);
      expect(hooks.hooks.SessionStart).toBeDefined();
      expect(hooks.hooks.PreToolUse).toBeDefined();

      const telemetry = files["codex-homes/coder/hooks/telemetry.js"];
      expect(telemetry).toContain("source: 'codex'");
      expect(telemetry).toContain("/workspace/.biodome-build/logs/codex-coder-events.jsonl");
      expect(telemetry).toContain("const CAPTURE_PAYLOADS = false");

      const start = files["codex-homes/coder/start.sh"];
      expect(start).toContain("#!/bin/sh");
      expect(start).toContain("exec-server --listen ws://0.0.0.0:3003");
      expect(start).toContain("--dangerously-bypass-hook-trust");

      const task = files["codex-homes/coder/task"];
      expect(task).toContain("#!/bin/sh");
      expect(task).toContain("HOME=/workspace/.biodome-build/codex-homes/coder");
      expect(task).toContain('codex -p "$@"');
      expect(task).toContain("aws s3 cp");
    });
  });

  describe("generateClaudeHarnessFiles", () => {
    it("generates Claude settings, mcp config, telemetry script, and wrapper", () => {
      const plan = createPlan("test");
      plan.build.mcpPort = 3001;
      plan.runtime.claudeHarnesses.push({
        name: "assistant",
        type: "claude",
        model: "claude-sonnet-4-20250514",
        apiKey: { env: "ANTHROPIC_API_KEY" },
        tools: ["Bash", "Read", "Edit"],
        permissions: "acceptEdits",
        telemetry: {
          enabled: true,
          path: "/workspace/.biodome-build/logs/claude-assistant-events.jsonl",
        },
        config: {},
      });

      const files = generateClaudeHarnessFiles(plan);
      const settings = JSON.parse(files["claude-homes/assistant/.claude/settings.json"]);
      expect(settings.model).toBe("claude-sonnet-4-20250514");
      expect(settings.permissions.allow).toEqual(["Bash", "Read", "Edit"]);
      expect(settings.hooks.PreToolUse).toBeDefined();

      const mcp = JSON.parse(files["claude-homes/assistant/.claude.json"]);
      expect(mcp.mcpServers.biodome.url).toBe("http://localhost:3001");

      const telemetry = files["claude-homes/assistant/hooks/telemetry.js"];
      expect(telemetry).toContain("source: 'claude'");
      expect(telemetry).toContain("/workspace/.biodome-build/logs/claude-assistant-events.jsonl");
      expect(telemetry).toContain("const CAPTURE_PAYLOADS = false");

      const wrapper = files["claude-homes/assistant/claude"];
      expect(wrapper).toContain("#!/bin/sh");
      expect(wrapper).toContain('ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"');
      expect(wrapper).toContain("--permission-mode acceptEdits");
      expect(wrapper).not.toContain("--skip-git-repo-check");

      const task = files["claude-homes/assistant/task"];
      expect(task).toContain("#!/bin/sh");
      expect(task).toContain("HOME=/workspace/.biodome-build/claude-homes/assistant");
      expect(task).toContain("CLAUDE_BIODOME_TELEMETRY_PATH=");
      expect(task).toContain('claude -p "$@"');
      expect(task).toContain("aws s3 cp");
    });
  });

  it("captures harness telemetry payloads only when explicitly enabled", () => {
    const plan = createPlan("test");
    const telemetry = { enabled: true, path: "/workspace/events.jsonl", capturePayloads: true };
    plan.runtime.agentHarnesses.push({
      name: "opencode",
      type: "opencode",
      port: 3002,
      mcpServers: {},
      telemetry,
      config: {},
    });
    plan.runtime.piHarnesses.push({ name: "pi", type: "pi", telemetry, config: {} });
    plan.runtime.codexHarnesses.push({
      name: "codex",
      type: "codex",
      port: 3003,
      mcpServers: {},
      telemetry,
      config: {},
    });
    plan.runtime.claudeHarnesses.push({ name: "claude", type: "claude", telemetry, config: {} });

    expect(
      generateHarnessFiles(plan)[
        "opencode-homes/opencode/.config/opencode/plugins/opencode-telemetry.js"
      ],
    ).toContain("const CAPTURE_PAYLOADS = true");
    expect(generatePiHarnessFiles(plan)["pi-homes/pi/extensions/biodome-telemetry.ts"]).toContain(
      "const CAPTURE_PAYLOADS = true",
    );
    expect(generateCodexHarnessFiles(plan)["codex-homes/codex/hooks/telemetry.js"]).toContain(
      "const CAPTURE_PAYLOADS = true",
    );
    expect(generateClaudeHarnessFiles(plan)["claude-homes/claude/hooks/telemetry.js"]).toContain(
      "const CAPTURE_PAYLOADS = true",
    );
  });

  it("writes shared telemetry records asynchronously with owner-only permissions", async () => {
    const plan = createPlan("test");
    plan.runtime.agentHarnesses.push({
      name: "agent",
      type: "opencode",
      port: 3002,
      mcpServers: {},
      telemetry: { enabled: true, path: "/workspace/events.jsonl" },
      config: {},
    });
    const dir = mkdtempSync(join(tmpdir(), "biodome-telemetry-"));
    const writerPath = join(dir, "writer.cjs");
    const logPath = join(dir, "logs", "events.jsonl");

    try {
      writeFileSync(writerPath, generateHarnessFiles(plan)["telemetry/writer.cjs"]);
      const writer = createRequire(import.meta.url)(writerPath) as {
        write: (path: string, event: unknown) => Promise<void>;
      };
      await writer.write(logPath, { source: "test", type: "event", data: { value: 1 } });

      expect(JSON.parse(readFileSync(logPath, "utf-8"))).toEqual({
        source: "test",
        type: "event",
        data: { value: 1 },
      });
      expect(statSync(join(dir, "logs")).mode & 0o777).toBe(0o700);
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
