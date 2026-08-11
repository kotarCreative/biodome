import type { Plan, Process } from "../../core/plan.js";
import { generatedRuntimeDir, shellQuote } from "./shell.js";

function hookCommand(hook: Process): string {
  const environment = Object.entries(hook.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const command = hook.command.map(shellQuote).join(" ");
  const invocation = environment.length > 0 ? `env ${environment.join(" ")} ${command}` : command;
  const workingDir = shellQuote(hook.workingDir ?? "/workspace");
  return `(
  cd ${workingDir}
  ${invocation}
)`;
}

function emitHooks(lines: string[], hooks: Process[]): void {
  for (const hook of hooks) {
    lines.push(`echo "[hook] ${hook.name}" >&2`);
    lines.push(hookCommand(hook));
    lines.push("");
  }
}

function startSupervisor(lines: string[], plan: Plan): void {
  const config = `${generatedRuntimeDir(plan)}/supervisord.conf`;
  lines.push(
    `supervisord -c ${shellQuote(config)} &`,
    "supervisord_pid=$!",
    "until supervisorctl -c " + shellQuote(config) + " pid >/dev/null 2>&1; do sleep 1; done",
    "",
  );
}

function startBootstrapProcesses(lines: string[], plan: Plan): void {
  const config = shellQuote(`${generatedRuntimeDir(plan)}/supervisord.conf`);
  for (const process of plan.runtime.processes) {
    if (process.mode !== "daemon" || !process.bootstrap) continue;
    lines.push(`supervisorctl -c ${config} start ${shellQuote(process.name)}`);
    if (process.healthCheck) {
      lines.push(
        `until sh ${shellQuote(`${generatedRuntimeDir(plan)}/healthchecks/${process.name}.sh`)} >/dev/null 2>&1; do sleep 1; done`,
      );
    }
  }
  if (plan.runtime.processes.some((process) => process.mode === "daemon" && process.bootstrap)) {
    lines.push("");
  }
}

/** Runs container lifecycle hooks around supervisord without involving the host CLI. */
export function generateStartupScript(plan: Plan): string | undefined {
  const preHooks = plan.runtime.processes.filter(
    (process) => process.mode === "oneshot" && process.startOn === "start.pre",
  );
  const postHooks = plan.runtime.processes.filter(
    (process) => process.mode === "oneshot" && process.startOn === "start.post",
  );
  const hasDaemons = plan.runtime.processes.some((process) => process.mode === "daemon");
  if (!hasDaemons && preHooks.length === 0 && postHooks.length === 0) return undefined;

  const lines = ["#!/bin/sh", "set -e", ""];
  if (!hasDaemons) {
    emitHooks(lines, preHooks);
    emitHooks(lines, postHooks);
    lines.push("exec sleep infinity", "");
    return lines.join("\n");
  }

  startSupervisor(lines, plan);
  startBootstrapProcesses(lines, plan);
  emitHooks(lines, preHooks);
  lines.push(
    `supervisorctl -c ${shellQuote(`${generatedRuntimeDir(plan)}/supervisord.conf`)} start all`,
    "",
  );
  emitHooks(lines, postHooks);
  lines.push('wait "$supervisord_pid"', "");
  return lines.join("\n");
}
