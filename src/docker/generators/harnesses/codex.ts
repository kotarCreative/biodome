import type { CodexHarness, Plan } from "../../../core/plan.js";
import { assertIdentifier, generatedRuntimeDir, shellQuote } from "../shell.js";
import {
  substituteConfigLines,
  taskWrapperScript,
  telemetryHookEntries,
  telemetryHookScript,
  telemetryWriterModule,
} from "./shared.js";

export function generateCodexHarnessFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  if (plan.runtime.codexHarnesses.length > 0) {
    files["telemetry/writer.cjs"] = telemetryWriterModule();
  }
  for (const harness of plan.runtime.codexHarnesses) {
    assertIdentifier(harness.name, "harness name");
    const homeDir = `codex-homes/${harness.name}`;
    files[`${homeDir}/.codex/config.toml`] = codexConfig(harness);
    files[`${homeDir}/.codex/hooks.json`] = codexHooks(harness, plan);
    files[`${homeDir}/hooks/telemetry.js`] = telemetryHookScript({
      tool: "Codex",
      source: "codex",
      pathEnvVar: "CODEX_BIODOME_TELEMETRY_PATH",
      logPath: harness.telemetry.path,
      capturePayloads: harness.telemetry.capturePayloads === true,
      plan,
    });
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
    if (server.auth) {
      // TOML has no interpolation and Codex does not support a `headers` map;
      // it sends `Authorization: Bearer <value>` from an env var name.
      lines.push(`bearer_token_env_var = ${JSON.stringify(server.auth.env)}`);
    }
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
  return JSON.stringify({ hooks: telemetryHookEntries(script) }, null, 2) + "\n";
}

function codexStartScript(harness: CodexHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/codex-homes/${harness.name}`;
  return [
    "#!/bin/sh",
    `# Auto-generated Codex start script for ${harness.name}`,
    "set -e",
    "",
    `CODEX_RUN_HOME="$(mktemp -d /tmp/.biodome-codex-${harness.name}-XXXXXX)"`,
    "trap 'rm -rf \"$CODEX_RUN_HOME\"' EXIT",
    `cp -r ${shellQuote(`${homeDir}/.codex`)} "$CODEX_RUN_HOME/.codex"`,
    'chmod -R go-rwx "$CODEX_RUN_HOME"',
    "",
    ...substituteConfigLines("$CODEX_RUN_HOME/.codex/config.toml"),
    "",
    `export HOME=${shellQuote(homeDir)}`,
    'export CODEX_HOME="$CODEX_RUN_HOME/.codex"',
    "",
    `exec codex --dangerously-bypass-hook-trust exec-server --listen ws://0.0.0.0:${harness.port}`,
    "",
  ].join("\n");
}

function codexTaskScript(harness: CodexHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/codex-homes/${harness.name}`;
  return taskWrapperScript({
    tool: "Codex",
    harnessName: harness.name,
    setupLines: [`export HOME=${shellQuote(homeDir)}`],
    commandLines: ['codex -p "$@"'],
  });
}
