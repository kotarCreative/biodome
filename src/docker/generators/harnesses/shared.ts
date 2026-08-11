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
