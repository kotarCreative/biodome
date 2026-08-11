import type { ClaudeHarness, Plan } from "../../../core/plan.js";
import { generatedRuntimeDir } from "../shell.js";
import {
  eventToSnakeCase,
  taskArtifactUploadLines,
  telemetryWriterModule,
  telemetryWriterPath,
} from "./shared.js";

export function generateClaudeHarnessFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  if (plan.runtime.claudeHarnesses.length > 0) {
    files["telemetry/writer.cjs"] = telemetryWriterModule();
  }
  for (const harness of plan.runtime.claudeHarnesses) {
    const homeDir = `claude-homes/${harness.name}`;
    files[`${homeDir}/.claude/settings.json`] = claudeSettings(harness, plan);
    files[`${homeDir}/.claude.json`] = claudeMcpConfig(plan.build.mcpPort);
    files[`${homeDir}/hooks/telemetry.js`] = claudeTelemetryScript(harness, plan);
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
  settings.hooks = hooks;

  return JSON.stringify(settings, null, 2) + "\n";
}

function claudeMcpConfig(mcpPort: number): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          biodome: {
            type: "http",
            url: `http://localhost:${mcpPort}`,
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function claudeTelemetryScript(harness: ClaudeHarness, plan: Plan): string {
  const logPath = harness.telemetry.path;
  const capturePayloads = harness.telemetry.capturePayloads === true;
  return [
    "// Auto-generated Claude telemetry hook script for biodome",
    "const { randomUUID } = require('node:crypto')",
    "",
    `const LOG_PATH = process.env.CLAUDE_BIODOME_TELEMETRY_PATH || ${JSON.stringify(logPath)}`,
    `const CAPTURE_PAYLOADS = ${capturePayloads}`,
    `const { write } = require(${JSON.stringify(telemetryWriterPath(plan))})`,
    "",
    "let input = ''",
    "process.stdin.on('data', (chunk) => { if (CAPTURE_PAYLOADS) input += chunk })",
    "process.stdin.on('end', async () => {",
    "  const data = input ? JSON.parse(input) : {}",
    "  await write(LOG_PATH, { id: randomUUID(), timestamp: new Date().toISOString(), source: 'claude', type: process.argv[2] || 'unknown', data })",
    "})",
    "",
  ].join("\n");
}

function claudeWrapperScript(harness: ClaudeHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/claude-homes/${harness.name}`;
  const envExports: string[] = [
    `HOME=${homeDir}`,
    "export HOME",
    `CLAUDE_BIODOME_TELEMETRY_PATH=${harness.telemetry.path}`,
    "export CLAUDE_BIODOME_TELEMETRY_PATH",
  ];
  if (harness.apiKey && typeof harness.apiKey === "object" && "env" in harness.apiKey) {
    envExports.push(`${harness.apiKey.env}="$${harness.apiKey.env}"`);
    envExports.push(`export ${harness.apiKey.env}`);
  }

  const flags: string[] = [];
  if (harness.model) flags.push(`--model ${harness.model}`);
  if (harness.permissions) {
    if (harness.permissions === "bypassPermissions") {
      flags.push("--dangerously-skip-permissions");
    } else {
      flags.push(`--permission-mode ${harness.permissions}`);
    }
  }
  if (harness.tools && harness.tools.length > 0) {
    flags.push(`--allowedTools ${harness.tools.join(",")}`);
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
  const lines: string[] = [
    "#!/bin/sh",
    `# Auto-generated Claude task wrapper for ${harness.name}`,
    "set -e",
    "",
    `export HOME=${homeDir}`,
    `export CLAUDE_BIODOME_TELEMETRY_PATH=${harness.telemetry.path}`,
  ];
  if (harness.apiKey && typeof harness.apiKey === "object" && "env" in harness.apiKey) {
    lines.push(`export ${harness.apiKey.env}="$${harness.apiKey.env}"`);
  }
  if (harness.model) {
    lines.push(`export CLAUDE_MODEL=${harness.model}`);
  }
  lines.push("");
  lines.push(`claude -p "$@"`);
  lines.push(...taskArtifactUploadLines());
  lines.push("");
  return lines.join("\n");
}
