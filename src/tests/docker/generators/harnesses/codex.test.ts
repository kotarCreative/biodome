import { describe, expect, it } from "vitest";
import { generateCodexHarnessFiles } from "../../../../docker/generators/harnesses/codex.js";
import { createPlan } from "../../../../core/plan.js";

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

  it("captures Codex telemetry payloads only when explicitly enabled", () => {
    const plan = createPlan("test");
    plan.runtime.codexHarnesses.push({
      name: "codex",
      type: "codex",
      port: 3003,
      mcpServers: {},
      telemetry: { enabled: true, path: "/workspace/events.jsonl", capturePayloads: true },
      config: {},
    });

    expect(generateCodexHarnessFiles(plan)["codex-homes/codex/hooks/telemetry.js"]).toContain(
      "const CAPTURE_PAYLOADS = true",
    );
  });
});
