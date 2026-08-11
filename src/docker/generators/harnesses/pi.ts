import type { PiHarness, Plan } from "../../../core/plan.js";
import { generatedRuntimeDir } from "../shell.js";
import { taskArtifactUploadLines, telemetryWriterModule, telemetryWriterPath } from "./shared.js";

export function generatePiHarnessFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  if (plan.runtime.piHarnesses.length > 0) {
    files["telemetry/writer.cjs"] = telemetryWriterModule();
  }
  for (const harness of plan.runtime.piHarnesses) {
    const homeDir = `pi-homes/${harness.name}`;
    files[`${homeDir}/settings.json`] = piSettings(harness, plan);
    files[`${homeDir}/pi`] = piWrapperScript(harness, plan);
    files[`${homeDir}/task`] = piTaskScript(harness, plan);
    if (harness.telemetry.enabled) {
      files[`${homeDir}/extensions/biodome-telemetry.ts`] = piTelemetryExtension(harness, plan);
    }
  }
  return files;
}

function piSettings(harness: PiHarness, plan?: Plan): string {
  const settings: Record<string, unknown> = {
    ...harness.config,
  };

  if (harness.provider) settings.defaultProvider = harness.provider;
  if (harness.model) settings.defaultModel = harness.model;

  const resources: string[] = [];
  if (harness.telemetry.enabled) {
    resources.push(
      `${generatedRuntimeDir(plan)}/pi-homes/${harness.name}/extensions/biodome-telemetry.ts`,
    );
  }
  if (harness.extensions) resources.push(...harness.extensions);
  if (resources.length > 0) settings.extensions = resources;
  if (harness.skills) settings.skills = harness.skills;
  if (harness.prompts) settings.prompts = harness.prompts;
  if (harness.themes) settings.themes = harness.themes;
  if (harness.packages) settings.packages = harness.packages;

  return JSON.stringify(settings, null, 2) + "\n";
}

function piWrapperScript(harness: PiHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/pi-homes/${harness.name}`;
  const envExports: string[] = [`export PI_CODING_AGENT_DIR=${homeDir}`];
  if (harness.apiKey && typeof harness.apiKey === "object" && "env" in harness.apiKey) {
    envExports.push(`export ${harness.apiKey.env}="$${harness.apiKey.env}"`);
  }

  const args: string[] = [];
  if (harness.tools && harness.tools.length > 0) {
    args.push(`--tools ${harness.tools.join(",")}`);
  }

  return [
    "#!/bin/sh",
    `# Auto-generated Pi wrapper for ${harness.name}`,
    "set -e",
    "",
    ...envExports,
    "",
    `exec pi ${args.join(" ")} "$@"`,
    "",
  ].join("\n");
}

function piTelemetryExtension(harness: PiHarness, plan: Plan): string {
  const logPath = harness.telemetry.path;
  const capturePayloads = harness.telemetry.capturePayloads === true;
  return [
    "// Auto-generated Pi telemetry extension for biodome",
    "import { randomUUID } from 'node:crypto'",
    "import { createRequire } from 'node:module'",
    "",
    `const LOG_PATH = process.env.PI_BIODOME_TELEMETRY_PATH || ${JSON.stringify(logPath)}`,
    `const CAPTURE_PAYLOADS = ${capturePayloads}`,
    "const require = createRequire(import.meta.url)",
    `const { write } = require(${JSON.stringify(telemetryWriterPath(plan))})`,
    "",
    "function baseEvent(type, data) {",
    "  return {",
    "    id: randomUUID(),",
    "    timestamp: new Date().toISOString(),",
    "    source: 'pi',",
    "    type,",
    "    data,",
    "  }",
    "}",
    "",
    "export default function (pi) {",
    "  pi.on('agent_start', async (event) => {",
    "    await write(LOG_PATH, baseEvent('agent_start', {}))",
    "  })",
    "",
    "  pi.on('agent_end', async (event) => {",
    "    await write(LOG_PATH, baseEvent('agent_end', CAPTURE_PAYLOADS ? { messages: event.messages, willRetry: event.willRetry } : { willRetry: event.willRetry }))",
    "  })",
    "",
    "  pi.on('tool_execution_start', async (event) => {",
    "    await write(LOG_PATH, baseEvent('tool_execution_start', CAPTURE_PAYLOADS ? { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args } : { toolCallId: event.toolCallId, toolName: event.toolName }))",
    "  })",
    "",
    "  pi.on('tool_execution_end', async (event) => {",
    "    await write(LOG_PATH, baseEvent('tool_execution_end', { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError }))",
    "  })",
    "}",
    "",
  ].join("\n");
}

function piTaskScript(harness: PiHarness, plan?: Plan): string {
  const homeDir = `${generatedRuntimeDir(plan)}/pi-homes/${harness.name}`;
  const lines: string[] = [
    "#!/bin/sh",
    `# Auto-generated Pi task wrapper for ${harness.name}`,
    "set -e",
    "",
    `export PI_CODING_AGENT_DIR=${homeDir}`,
  ];
  if (harness.apiKey && typeof harness.apiKey === "object" && "env" in harness.apiKey) {
    lines.push(`export ${harness.apiKey.env}="$${harness.apiKey.env}"`);
  }
  lines.push("");
  lines.push(`pi -p "$@"`);
  lines.push(...taskArtifactUploadLines());
  lines.push("");
  return lines.join("\n");
}
