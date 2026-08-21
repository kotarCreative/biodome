import type { ClaudeHarness, McpConfig, Plan } from "../../../core/plan.js";
import { mcpClientAuthFromToken } from "../../../core/mcp-client.js";
import { assertIdentifier, generatedRuntimeDir, shellQuote } from "../shell.js";
import {
  taskWrapperScript,
  telemetryHookEntries,
  telemetryHookScript,
  telemetryWriterModule,
} from "./shared.js";

export function generateClaudeHarnessFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  if (plan.runtime.claudeHarnesses.length > 0) {
    files["telemetry/writer.cjs"] = telemetryWriterModule();
  }
  for (const harness of plan.runtime.claudeHarnesses) {
    assertIdentifier(harness.name, "harness name");
    const homeDir = `claude-homes/${harness.name}`;
    files[`${homeDir}/.claude/settings.json`] = claudeSettings(harness, plan);
    files[`${homeDir}/.claude.json`] = claudeMcpConfig(plan.build.mcpPort, plan.build.mcpConfig);
    files[`${homeDir}/hooks/telemetry.js`] = telemetryHookScript({
      tool: "Claude",
      source: "claude",
      pathEnvVar: "CLAUDE_BIODOME_TELEMETRY_PATH",
      logPath: harness.telemetry.path,
      capturePayloads: harness.telemetry.capturePayloads === true,
      plan,
    });
    files[`${homeDir}/claude`] = claudeWrapperScript(harness, plan);
    files[`${homeDir}/task`] = claudeTaskScript(harness, plan);
  }
  return files;
}

function claudeSettings(harness: ClaudeHarness, plan?: Plan): string {
  const settings: Record<string, unknown> = {
    ...harness.config,
  };

  if (harness.model) settings.model = harness.model;
  if (harness.tools && harness.tools.length > 0) {
    settings.permissions = { allow: harness.tools };
  }

  const homeDir = `${generatedRuntimeDir(plan)}/claude-homes/${harness.name}`;
  const script = `${homeDir}/hooks/telemetry.js`;
  settings.hooks = telemetryHookEntries(script);

  return JSON.stringify(settings, null, 2) + "\n";
}

function claudeMcpConfig(mcpPort: number, mcpConfig: McpConfig): string {
  const biodome: Record<string, unknown> = {
    type: "http",
    url: `http://localhost:${mcpPort}`,
  };
  if (mcpConfig.enabled && mcpConfig.token && typeof mcpConfig.token === "object") {
    const auth = mcpClientAuthFromToken(mcpConfig.token);
    biodome.headers = { [auth.header]: auth.value };
  }
  return JSON.stringify({ mcpServers: { biodome } }, null, 2) + "\n";
}

function claudeWrapperScript(harness: ClaudeHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/claude-homes/${harness.name}`;
  const envExports: string[] = [
    `HOME=${shellQuote(homeDir)}`,
    "export HOME",
    `CLAUDE_BIODOME_TELEMETRY_PATH=${shellQuote(harness.telemetry.path)}`,
    "export CLAUDE_BIODOME_TELEMETRY_PATH",
  ];
  if (harness.apiKey && typeof harness.apiKey === "object" && "env" in harness.apiKey) {
    assertIdentifier(harness.apiKey.env, "API key environment variable name");
    envExports.push(`${harness.apiKey.env}="$${harness.apiKey.env}"`);
    envExports.push(`export ${harness.apiKey.env}`);
  }

  const flags: string[] = [];
  if (harness.model) flags.push(`--model ${shellQuote(harness.model)}`);
  if (harness.permissions) {
    if (harness.permissions === "bypassPermissions") {
      flags.push("--dangerously-skip-permissions");
    } else {
      flags.push(`--permission-mode ${shellQuote(harness.permissions)}`);
    }
  }
  if (harness.tools && harness.tools.length > 0) {
    flags.push(`--allowedTools ${shellQuote(harness.tools.join(","))}`);
  }

  return [
    "#!/bin/sh",
    `# Auto-generated Claude wrapper for ${harness.name}`,
    "set -e",
    "",
    ...envExports,
    "",
    `exec claude ${flags.join(" ")} "$@"`,
    "",
  ].join("\n");
}

function claudeTaskScript(harness: ClaudeHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/claude-homes/${harness.name}`;
  const setupLines: string[] = [
    `export HOME=${shellQuote(homeDir)}`,
    `export CLAUDE_BIODOME_TELEMETRY_PATH=${shellQuote(harness.telemetry.path)}`,
  ];
  if (harness.apiKey && typeof harness.apiKey === "object" && "env" in harness.apiKey) {
    assertIdentifier(harness.apiKey.env, "API key environment variable name");
    setupLines.push(`export ${harness.apiKey.env}="$${harness.apiKey.env}"`);
  }
  if (harness.model) {
    setupLines.push(`export CLAUDE_MODEL=${shellQuote(harness.model)}`);
  }
  return taskWrapperScript({
    tool: "Claude",
    harnessName: harness.name,
    setupLines,
    commandLines: [`claude -p "$@"`],
  });
}
