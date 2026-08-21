import { describe, expect, it } from "vitest";
import { generateOpencodeHarnessFiles } from "../../../../docker/generators/harnesses/opencode.js";
import { createPlan } from "../../../../core/plan.js";

describe("generateOpencodeHarnessFiles", () => {
  it("generates opencode config and telemetry plugin", () => {
    const plan = createPlan("my-app");
    plan.runtime.agentHarnesses.push({
      name: "agent",
      type: "opencode",
      port: 3002,
      mcpServers: {
        biodome: {
          url: "http://localhost:3001",
          auth: { header: "Authorization", env: "MCP_TOKEN", value: "Bearer ${MCP_TOKEN}" },
        },
      },
      telemetry: { enabled: true, path: "/workspace/.biodome-build/logs/opencode-events.jsonl" },
      config: {},
    });

    const files = generateOpencodeHarnessFiles(plan);
    const configPath = "opencode-homes/agent/.config/opencode/opencode.json";
    const pluginPath = "opencode-homes/agent/.config/opencode/plugins/agent-telemetry.js";
    const startPath = "opencode-homes/agent/start.sh";

    expect(files[configPath]).toContain('"$schema": "https://opencode.ai/config.json"');
    expect(files[configPath]).toContain('"mcp"');
    expect(files[configPath]).toContain('"biodome"');
    expect(files[configPath]).toContain('"type": "remote"');
    expect(files[configPath]).toContain("http://localhost:3001");
    expect(files[configPath]).toContain("plugins/agent-telemetry.js");
    const config = JSON.parse(files[configPath]);
    expect(config.mcp.biodome).toEqual({
      type: "remote",
      url: "http://localhost:3001",
      headers: { Authorization: "Bearer ${MCP_TOKEN}" },
    });

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
    expect(files[startPath]).toContain("mktemp -d /tmp/.biodome-opencode-agent-XXXXXX");
    expect(files[startPath]).toContain(
      'cp -r /workspace/.biodome-build/opencode-homes/agent/.config "$OPENCODE_RUN_HOME/.config"',
    );
    expect(files[startPath]).toContain('chmod -R go-rwx "$OPENCODE_RUN_HOME"');
    expect(files[startPath]).toContain('\' "$OPENCODE_RUN_HOME/.config/opencode/opencode.json"');
    expect(files[startPath]).toContain('export XDG_CONFIG_HOME="$OPENCODE_RUN_HOME/.config"');
    expect(files[startPath]).toContain("is not set");
    expect(files[startPath]).not.toContain("process.env[name] ||");

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

    const task = generateOpencodeHarnessFiles(plan)["opencode-homes/agent/task"];
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

    const files = generateOpencodeHarnessFiles(plan);
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

  it("captures OpenCode telemetry payloads only when explicitly enabled", () => {
    const plan = createPlan("test");
    plan.runtime.agentHarnesses.push({
      name: "opencode",
      type: "opencode",
      port: 3002,
      mcpServers: {},
      telemetry: { enabled: true, path: "/workspace/events.jsonl", capturePayloads: true },
      config: {},
    });

    expect(
      generateOpencodeHarnessFiles(plan)[
        "opencode-homes/opencode/.config/opencode/plugins/opencode-telemetry.js"
      ],
    ).toContain("const CAPTURE_PAYLOADS = true");
  });
});
