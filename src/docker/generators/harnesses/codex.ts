import type { CodexHarness, Plan } from "../../../core/plan.js";
import { generatedRuntimeDir } from "../shell.js";
import {
  eventToSnakeCase,
  taskArtifactUploadLines,
  telemetryWriterModule,
  telemetryWriterPath,
} from "./shared.js";

export function generateCodexHarnessFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  if (plan.runtime.codexHarnesses.length > 0) {
    files["telemetry/writer.cjs"] = telemetryWriterModule();
  }
  for (const harness of plan.runtime.codexHarnesses) {
    const homeDir = `codex-homes/${harness.name}`;
    files[`${homeDir}/.codex/config.toml`] = codexConfig(harness);
    files[`${homeDir}/.codex/hooks.json`] = codexHooks(harness, plan);
    files[`${homeDir}/hooks/telemetry.js`] = codexTelemetryScript(harness, plan);
    files[`${homeDir}/start.sh`] = codexStartScript(harness, plan);
    files[`${homeDir}/task`] = codexTaskScript(harness, plan);
  }
  return files;
}

function tomlValue(value: unknown): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  return JSON.stringify(String(value));
}

function codexConfig(harness: CodexHarness): string {
  const topLevel: Record<string, unknown> = {
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    ...harness.config,
  };
  if (harness.model && topLevel.model === undefined) {
    topLevel.model = harness.model;
  }

  const lines: string[] = ["# Auto-generated Codex config for biodome"];

  const tables: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(topLevel)) {
    if (value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value) && value !== null) {
      tables[key] = value as Record<string, unknown>;
      continue;
    }
    lines.push(`${key} = ${tomlValue(value)}`);
  }

  for (const [name, server] of Object.entries(harness.mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`url = ${JSON.stringify(server.url)}`);
  }

  for (const [key, value] of Object.entries(tables)) {
    lines.push(`[${key}]`);
    for (const [k, v] of Object.entries(value)) {
      lines.push(`${k} = ${tomlValue(v)}`);
    }
  }

  return lines.join("\n") + "\n";
}

function codexHooks(harness: CodexHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/codex-homes/${harness.name}`;
  const script = `${homeDir}/hooks/telemetry.js`;
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];
  const hooks: Record<string, unknown> = {};
  for (const event of events) {
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: [script, eventToSnakeCase(event)],
          },
        ],
      },
    ];
  }
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

function codexTelemetryScript(harness: CodexHarness, plan: Plan): string {
  const logPath = harness.telemetry.path;
  const capturePayloads = harness.telemetry.capturePayloads === true;
  return [
    "// Auto-generated Codex telemetry hook script for biodome",
    "const { randomUUID } = require('node:crypto')",
    "",
    `const LOG_PATH = process.env.CODEX_BIODOME_TELEMETRY_PATH || ${JSON.stringify(logPath)}`,
    `const CAPTURE_PAYLOADS = ${capturePayloads}`,
    `const { write } = require(${JSON.stringify(telemetryWriterPath(plan))})`,
    "",
    "let input = ''",
    "process.stdin.on('data', (chunk) => { if (CAPTURE_PAYLOADS) input += chunk })",
    "process.stdin.on('end', async () => {",
    "  const data = input ? JSON.parse(input) : {}",
    "  await write(LOG_PATH, { id: randomUUID(), timestamp: new Date().toISOString(), source: 'codex', type: process.argv[2] || 'unknown', data })",
    "})",
    "",
  ].join("\n");
}

function codexStartScript(harness: CodexHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/codex-homes/${harness.name}`;
  const configPath = `${homeDir}/.codex/config.toml`;
  return [
    "#!/bin/sh",
    `# Auto-generated Codex start script for ${harness.name}`,
    "set -e",
    "",
    `export HOME=${homeDir}`,
    "",
    `# Substitute \${VAR} references in the generated config with runtime env vars.`,
    "node -e '",
    'const fs = require("fs");',
    `const file = ${JSON.stringify(configPath)};`,
    'let text = fs.readFileSync(file, "utf8");',
    'text = text.replace(/\\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_, name) => process.env[name] || "");',
    "fs.writeFileSync(file, text);",
    "'",
    "",
    `exec codex --dangerously-bypass-hook-trust exec-server --listen ws://0.0.0.0:${harness.port}`,
    "",
  ].join("\n");
}

function codexTaskScript(harness: CodexHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/codex-homes/${harness.name}`;
  const lines: string[] = [
    "#!/bin/sh",
    `# Auto-generated Codex task wrapper for ${harness.name}`,
    "set -e",
    "",
    `export HOME=${homeDir}`,
  ];
  lines.push("");
  lines.push('codex -p "$@"');
  lines.push(...taskArtifactUploadLines());
  lines.push("");
  return lines.join("\n");
}
