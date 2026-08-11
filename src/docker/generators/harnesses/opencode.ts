import type { AgentHarness, LlmProvider, Plan } from "../../../core/plan.js";
import { runtimeLayout } from "../../../runtime/layout.js";
import { generatedRuntimeDir } from "../shell.js";
import { taskArtifactUploadLines, telemetryWriterModule, telemetryWriterPath } from "./shared.js";

export function generateHarnessFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  if (plan.runtime.agentHarnesses.length > 0) {
    files["telemetry/writer.cjs"] = telemetryWriterModule();
  }
  for (const harness of plan.runtime.agentHarnesses) {
    if (harness.type === "opencode") {
      const homeDir = `opencode-homes/${harness.name}`;
      files[`${homeDir}/.config/opencode/opencode.json`] = opencodeConfig(
        harness,
        plan.runtime.llmProviders,
      );
      files[`${homeDir}/.config/opencode/plugins/${harness.name}-telemetry.js`] =
        opencodeTelemetryPlugin(harness, plan);
      files[`${homeDir}/start.sh`] = opencodeStartScript(harness, plan);
      files[`${homeDir}/task`] = opencodeTaskScript(harness, plan);
    }
  }
  return files;
}

function opencodeConfig(harness: AgentHarness, llmProviders: LlmProvider[]): string {
  const mcp: Record<string, any> = {};
  for (const [name, server] of Object.entries(harness.mcpServers)) {
    mcp[name] = { type: "remote", url: server.url };
    if (server.auth) {
      mcp[name].headers = { [server.auth.header]: server.auth.value };
    }
  }

  const provider: Record<string, any> = {};
  const providerEnv: Record<string, string> = {};
  for (const p of llmProviders) {
    const options: Record<string, any> = {};
    for (const [key, value] of Object.entries(p.options)) {
      if (value !== undefined && typeof value === "object" && "env" in value) {
        options[key] = `\${${value.env}}`;
        providerEnv[value.env] = `\${${value.env}}`;
      } else {
        options[key] = value;
      }
    }

    provider[p.name] = {
      npm: p.npm,
      name: p.displayName,
      options,
      models: p.models,
    };
  }

  const config: Record<string, any> = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    plugin: [[`plugins/${harness.name}-telemetry.js`, {}]],
    mcp,
    provider,
    ...harness.config,
  };

  return JSON.stringify(config, null, 2) + "\n";
}

function opencodeStartScript(harness: AgentHarness, plan: Plan): string {
  const configPath = `${runtimeLayout("", plan.deployment?.target.name).container.opencodeHomes}/${harness.name}/.config/opencode/opencode.json`;
  return [
    "#!/bin/sh",
    `# Auto-generated OpenCode start script for ${harness.name}`,
    "set -e",
    "",
    `# Substitute \${VAR} references in the generated config with runtime env vars.`,
    "node -e '",
    'const fs = require("fs");',
    `const file = ${JSON.stringify(configPath)};`,
    'let text = fs.readFileSync(file, "utf8");',
    'text = text.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_, name) => process.env[name] || "");',
    "fs.writeFileSync(file, text);",
    "'",
    "",
    `exec opencode serve --port ${harness.port} --hostname 0.0.0.0 --print-logs`,
    "",
  ].join("\n");
}

function opencodeTaskScript(harness: AgentHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/opencode-homes/${harness.name}`;
  const configPath = `${homeDir}/.config/opencode/opencode.json`;
  return [
    "#!/bin/sh",
    `# Auto-generated OpenCode task wrapper for ${harness.name}`,
    "set -e",
    "",
    `# Run non-interactively with a single prompt, like \`opencode serve\`'s sibling wrappers.`,
    `export HOME=${homeDir}`,
    "",
    `# Substitute \${VAR} references in the generated config with runtime env vars`,
    `# (e.g. the LLM provider apiKey) so auth works outside the serve path.`,
    "node -e '",
    'const fs = require("fs");',
    `const file = ${JSON.stringify(configPath)};`,
    'let text = fs.readFileSync(file, "utf8");',
    'text = text.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_, name) => process.env[name] || "");',
    "fs.writeFileSync(file, text);",
    "'",
    "",
    `# OpenCode CLI: single-prompt non-interactive mode (prompt arrives as "$@").`,
    'opencode run "$@"',
    ...taskArtifactUploadLines(),
    "",
  ].join("\n");
}

function opencodeTelemetryPlugin(harness: AgentHarness, plan: Plan): string {
  const logPath = harness.telemetry.path;
  const capturePayloads = harness.telemetry.capturePayloads === true;
  return [
    "// Auto-generated OpenCode telemetry plugin for biodome",
    "import { randomUUID } from 'node:crypto'",
    "import { createRequire } from 'node:module'",
    "",
    `const LOG_PATH = process.env.OPENCODE_TELEMETRY_PATH || ${JSON.stringify(logPath)}`,
    `const CAPTURE_PAYLOADS = ${capturePayloads}`,
    "const require = createRequire(import.meta.url)",
    `const { write } = require(${JSON.stringify(telemetryWriterPath(plan))})`,
    "",
    "function baseEvent(type, data) {",
    "  return {",
    "    id: randomUUID(),",
    "    timestamp: new Date().toISOString(),",
    "    source: 'opencode',",
    "    type,",
    "    data,",
    "  }",
    "}",
    "",
    "export default async () => {",
    "  return {",
    "    event: async ({ event }) => {",
    "      await write(LOG_PATH, baseEvent('event', CAPTURE_PAYLOADS ? { name: event.name, payload: event.payload } : { name: event.name }))",
    "    },",
    "    'tool.execute.before': async ({ tool, sessionID, callID, args }) => {",
    "      await write(LOG_PATH, baseEvent('tool.execute.before', CAPTURE_PAYLOADS ? { tool, sessionID, callID, args } : { tool, sessionID, callID }))",
    "    },",
    "    'tool.execute.after': async ({ tool, sessionID, callID, args, output, title }) => {",
    "      await write(LOG_PATH, baseEvent('tool.execute.after', CAPTURE_PAYLOADS ? { tool, sessionID, callID, args, output, title } : { tool, sessionID, callID }))",
    "    },",
    "    'chat.message': async ({ sessionID, message, parts }) => {",
    "      await write(LOG_PATH, baseEvent('chat.message', CAPTURE_PAYLOADS ? { sessionID, message, parts } : { sessionID }))",
    "    },",
    "  }",
    "}",
    "",
  ].join("\n");
}
