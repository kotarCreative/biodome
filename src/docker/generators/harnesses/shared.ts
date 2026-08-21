import type { Plan } from "../../../core/plan.js";
import { generatedRuntimeDir } from "../shell.js";

export function telemetryWriterModule(): string {
  return [
    "// Shared telemetry writer for generated Biodome harnesses.",
    "const fs = require('node:fs/promises')",
    "const path = require('node:path')",
    "",
    "const MAX_BYTES = 10 * 1024 * 1024",
    "const MAX_ROTATIONS = 5",
    "let pending = Promise.resolve()",
    "",
    "async function rotate(logPath, nextBytes) {",
    "  const stat = await fs.stat(logPath).catch(() => null)",
    "  if (!stat || stat.size === 0 || stat.size + nextBytes <= MAX_BYTES) return",
    "  await fs.rm(`${logPath}.${MAX_ROTATIONS}`, { force: true })",
    "  for (let index = MAX_ROTATIONS - 1; index >= 1; index--) {",
    "    await fs.rename(`${logPath}.${index}`, `${logPath}.${index + 1}`).catch(() => {})",
    "  }",
    "  await fs.rename(logPath, `${logPath}.1`)",
    "}",
    "",
    "function write(logPath, event) {",
    "  const line = JSON.stringify(event) + '\\n'",
    "  const operation = pending.then(async () => {",
    "    const dir = path.dirname(logPath)",
    "    await fs.mkdir(dir, { recursive: true, mode: 0o700 })",
    "    await fs.chmod(dir, 0o700)",
    "    await rotate(logPath, Buffer.byteLength(line))",
    "    const handle = await fs.open(logPath, 'a', 0o600)",
    "    try { await handle.write(line) } finally { await handle.close() }",
    "    await fs.chmod(logPath, 0o600)",
    "  })",
    "  pending = operation.catch((error) => console.error('[biodome-telemetry] failed to write event:', error.message))",
    "  return pending",
    "}",
    "",
    "module.exports = { write }",
    "",
  ].join("\n");
}

export function telemetryWriterPath(plan: Plan): string {
  return `${generatedRuntimeDir(plan)}/telemetry/writer.cjs`;
}

// Substitutes ${VAR} references into a private per-run copy of the config so
// resolved secrets never persist in the workspace and unset vars fail loudly.
export const substituteConfigModule = [
  'const fs = require("fs");',
  "const file = process.argv[1];",
  'const text = fs.readFileSync(file, "utf8");',
  "const resolved = text.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_, name) => {",
  "  const value = process.env[name];",
  '  if (value === undefined || value === "") {',
  '    console.error("biodome: environment variable " + name + " referenced by " + file + " is not set");',
  "    process.exit(1);",
  "  }",
  "  return value;",
  "});",
  "fs.writeFileSync(file, resolved);",
].join("\n");

export function taskArtifactUploadLines(): string[] {
  return [
    "",
    "# ECS task runs provide a bucket and declared paths; local runs leave these unset.",
    'if [ -n "${BIODOME_ARTIFACT_BUCKET:-}" ] && [ -n "${BIODOME_ARTIFACT_PATHS:-}" ]; then',
    "  printf '%s' \"$BIODOME_ARTIFACT_PATHS\" | node -e '",
    "const chunks = [];",
    'process.stdin.on("data", (chunk) => chunks.push(chunk));',
    'process.stdin.on("end", () => {',
    '  for (const path of JSON.parse(Buffer.concat(chunks).toString("utf8"))) {',
    '    console.log(Buffer.from(path).toString("base64"));',
    "  }",
    "});",
    "' | while IFS= read -r encoded; do",
    '    path="$(printf \'%s\' "$encoded" | base64 -d)"',
    '    aws s3 cp "/workspace/$path" "s3://${BIODOME_ARTIFACT_BUCKET}/${BIODOME_ARTIFACT_PREFIX}/${BIODOME_DEPLOYMENT_ID}/$path" --only-show-errors',
    "  done",
    "fi",
  ];
}

export function eventToSnakeCase(name: string): string {
  return name
    .split(/(?=[A-Z])/)
    .join("_")
    .toLowerCase();
}

const TELEMETRY_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];

// Claude and Codex share the same stdin-driven hook script; only the tool label,
// emitted source name, and env var override differ.
export interface TelemetryHookScriptParams {
  tool: string;
  source: string;
  pathEnvVar: string;
  logPath: string;
  capturePayloads: boolean;
  plan: Plan;
}

export function telemetryHookScript(params: TelemetryHookScriptParams): string {
  return [
    `// Auto-generated ${params.tool} telemetry hook script for biodome`,
    "const { randomUUID } = require('node:crypto')",
    "",
    `const LOG_PATH = process.env.${params.pathEnvVar} || ${JSON.stringify(params.logPath)}`,
    `const CAPTURE_PAYLOADS = ${params.capturePayloads}`,
    `const { write } = require(${JSON.stringify(telemetryWriterPath(params.plan))})`,
    "",
    "let input = ''",
    "process.stdin.on('data', (chunk) => { if (CAPTURE_PAYLOADS) input += chunk })",
    "process.stdin.on('end', async () => {",
    "  const data = input ? JSON.parse(input) : {}",
    `  await write(LOG_PATH, { id: randomUUID(), timestamp: new Date().toISOString(), source: '${params.source}', type: process.argv[2] || 'unknown', data })`,
    "})",
    "",
  ].join("\n");
}

// Event → matcher entries for the telemetry hook, shared by Claude settings.json
// (nested under `hooks`) and Codex hooks.json (the document body).
export function telemetryHookEntries(script: string): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of TELEMETRY_HOOK_EVENTS) {
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
  return hooks;
}

// Resolves ${VAR} references in a copied config file before a harness reads it.
export function substituteConfigLines(configPath: string): string[] {
  return ["node -e '", substituteConfigModule, `' "${configPath}"`];
}

// Common scaffolding for the per-harness non-interactive task wrappers:
// shebang, set -e, setup exports, command line, artifact upload tail.
export interface TaskScriptParams {
  tool: string;
  harnessName: string;
  setupLines: string[];
  commandLines: string[];
}

export function taskWrapperScript(params: TaskScriptParams): string {
  return [
    "#!/bin/sh",
    `# Auto-generated ${params.tool} task wrapper for ${params.harnessName}`,
    "set -e",
    "",
    ...params.setupLines,
    "",
    ...params.commandLines,
    ...taskArtifactUploadLines(),
    "",
  ].join("\n");
}
