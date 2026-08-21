import type { AgentHarness, LlmProvider, Plan } from "../../../core/plan.js";
import { assertIdentifier, generatedRuntimeDir, shellQuote } from "../shell.js";
import {
  substituteConfigLines,
  taskWrapperScript,
  telemetryWriterModule,
  telemetryWriterPath,
} from "./shared.js";

export function generateOpencodeHarnessFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  if (plan.runtime.agentHarnesses.length > 0) {
    files["telemetry/writer.cjs"] = telemetryWriterModule();
  }
  for (const harness of plan.runtime.agentHarnesses) {
    if (harness.type === "opencode") {
      assertIdentifier(harness.name, "harness name");
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

// Back-compat alias: src/runtime/artifacts.ts imports this module directly and
// still uses the pre-rename name.
export { generateOpencodeHarnessFiles as generateHarnessFiles };

function opencodeConfig(harness: AgentHarness, llmProviders: LlmProvider[]): string {
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(harness.mcpServers)) {
    const entry: Record<string, unknown> = { type: "remote", url: server.url };
    if (server.auth) {
      entry.headers = { [server.auth.header]: server.auth.value };
    }
    mcp[name] = entry;
  }

  const provider: Record<string, unknown> = {};
  for (const p of llmProviders) {
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(p.options)) {
      if (value !== undefined && typeof value === "object" && "env" in value) {
        options[key] = `\${${value.env}}`;
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

  const config: Record<string, unknown> = {
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
  const homeDir = `${generatedRuntimeDir(plan)}/opencode-homes/${harness.name}`;
  return [
    "#!/bin/sh",
    `# Auto-generated OpenCode start script for ${harness.name}`,
    "set -e",
    "",
    `OPENCODE_RUN_HOME="$(mktemp -d /tmp/.biodome-opencode-${harness.name}-XXXXXX)"`,
    "trap 'rm -rf \"$OPENCODE_RUN_HOME\"' EXIT",
    `cp -r ${shellQuote(`${homeDir}/.config`)} "$OPENCODE_RUN_HOME/.config"`,
    'chmod -R go-rwx "$OPENCODE_RUN_HOME"',
    "",
    ...substituteConfigLines("$OPENCODE_RUN_HOME/.config/opencode/opencode.json"),
    "",
    'export XDG_CONFIG_HOME="$OPENCODE_RUN_HOME/.config"',
    "",
    `exec opencode serve --port ${harness.port} --hostname 0.0.0.0 --print-logs`,
    "",
  ].join("\n");
}

function opencodeTaskScript(harness: AgentHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/opencode-homes/${harness.name}`;
  return taskWrapperScript({
    tool: "OpenCode",
    harnessName: harness.name,
    setupLines: [
      `# Run non-interactively with a single prompt, like \`opencode serve\`'s sibling wrappers.`,
      `export HOME=${shellQuote(homeDir)}`,
      "",
      "# Resolve ${VAR} references (e.g. the LLM provider apiKey) into a private",
      "# per-run copy so auth works outside the serve path without persisting secrets.",
      `OPENCODE_RUN_HOME="$(mktemp -d /tmp/.biodome-opencode-${harness.name}-XXXXXX)"`,
      "trap 'rm -rf \"$OPENCODE_RUN_HOME\"' EXIT",
      `cp -r ${shellQuote(`${homeDir}/.config`)} "$OPENCODE_RUN_HOME/.config"`,
      'chmod -R go-rwx "$OPENCODE_RUN_HOME"',
      "",
      ...substituteConfigLines("$OPENCODE_RUN_HOME/.config/opencode/opencode.json"),
      "",
      'export XDG_CONFIG_HOME="$OPENCODE_RUN_HOME/.config"',
    ],
    commandLines: [
      `# OpenCode CLI: single-prompt non-interactive mode (prompt arrives as "$@").`,
      'opencode run "$@"',
    ],
  });
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
