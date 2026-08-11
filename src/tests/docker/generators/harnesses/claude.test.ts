import { describe, expect, it } from "vitest";
import { generateClaudeHarnessFiles } from "../../../../docker/generators/harnesses/claude.js";
import { createPlan } from "../../../../core/plan.js";

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

  it("captures Claude telemetry payloads only when explicitly enabled", () => {
    const plan = createPlan("test");
    plan.runtime.claudeHarnesses.push({
      name: "claude",
      type: "claude",
      telemetry: { enabled: true, path: "/workspace/events.jsonl", capturePayloads: true },
      config: {},
    });

    expect(generateClaudeHarnessFiles(plan)["claude-homes/claude/hooks/telemetry.js"]).toContain(
      "const CAPTURE_PAYLOADS = true",
    );
  });
});
