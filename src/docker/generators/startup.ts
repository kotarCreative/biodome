import type { Plan, Process } from "../../core/plan.js";
import { assertIdentifier, generatedRuntimeDir, shellQuote, supervisorLogDir } from "./shell.js";

function hookCommand(hook: Process): string {
  const environment = Object.entries(hook.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `${assertIdentifier(key, "environment variable name")}=${shellQuote(value)}`,
    );
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
    assertIdentifier(hook.name, "hook name");
    lines.push(`echo "[hook] ${hook.name}" >&2`);
    lines.push(hookCommand(hook));
    lines.push("");
  }
}

const SUPERVISOR_READY_TIMEOUT_SECONDS = 60;
const BOOTSTRAP_HEALTH_TIMEOUT_SECONDS = 300;

/** Emits a bounded wait loop so a never-ready condition fails loudly instead of hanging forever. */
function boundedWait(
  lines: string[],
  options: { condition: string; timeoutSeconds: number; failureMessage: string },
): void {
  lines.push(
    "wait_attempts=0",
    `until ${options.condition}; do`,
    "  wait_attempts=$((wait_attempts + 1))",
    `  if [ "$wait_attempts" -ge ${options.timeoutSeconds} ]; then`,
    `    echo ${shellQuote(`biodome: ${options.failureMessage}`)} >&2`,
    "    exit 1",
    "  fi",
    "  sleep 1",
    "done",
  );
}

function startSupervisor(lines: string[], plan: Plan): void {
  const config = `${generatedRuntimeDir(plan)}/supervisord.conf`;
  const quotedConfig = shellQuote(config);
  const logDir = shellQuote(supervisorLogDir(plan));
  const runtimeDir = shellQuote(generatedRuntimeDir(plan));
  lines.push(
    // supervisord does not create missing log directories, and its log,
    // pidfile, socket, and per-program logs all live in the private runtime
    // dir rather than world-writable /tmp.
    `mkdir -p ${logDir}`,
    // Direct Compose users may not have run the host renderer. Match the
    // mounted runtime directory's owner when GNU chown is available.
    `chown --reference=${runtimeDir} ${logDir} 2>/dev/null || true`,
    `chmod 700 ${logDir}`,
    `supervisord -c ${quotedConfig} &`,
    "supervisord_pid=$!",
  );
  boundedWait(lines, {
    condition: `supervisorctl -c ${quotedConfig} pid >/dev/null 2>&1`,
    timeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
    failureMessage: `supervisord did not become ready within ${SUPERVISOR_READY_TIMEOUT_SECONDS}s; check ${supervisorLogDir(plan)}/supervisord.log`,
  });
  lines.push("");
}

function startBootstrapProcesses(lines: string[], plan: Plan): void {
  const config = shellQuote(`${generatedRuntimeDir(plan)}/supervisord.conf`);
  for (const process of plan.runtime.processes) {
    if (process.mode !== "daemon" || !process.bootstrap) continue;
    assertIdentifier(process.name, "process name");
    lines.push(`supervisorctl -c ${config} start ${shellQuote(process.name)}`);
    if (process.healthCheck) {
      boundedWait(lines, {
        condition: `sh ${shellQuote(`${generatedRuntimeDir(plan)}/healthchecks/${process.name}.sh`)} >/dev/null 2>&1`,
        timeoutSeconds: BOOTSTRAP_HEALTH_TIMEOUT_SECONDS,
        failureMessage: `bootstrap process "${process.name}" did not become healthy within ${BOOTSTRAP_HEALTH_TIMEOUT_SECONDS}s`,
      });
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
