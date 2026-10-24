import type { Plan, Process, ProcessHealthCheck } from "../../core/plan.js";
import { assertIdentifier, generatedRuntimeDir, parseDuration, shellQuote } from "./shell.js";

export function generateHealthcheckScripts(plan: Plan): Record<string, string> {
  const scripts: Record<string, string> = {};
  const daemonProcesses = plan.runtime.processes.filter((p) => p.mode === "daemon");
  for (const proc of daemonProcesses) {
    if (proc.healthCheck) {
      assertIdentifier(proc.name, "process name");
      scripts[`${proc.name}.sh`] = processHealthCheckScript(proc);
      scripts[`${proc.name}-monitor.sh`] = processHealthMonitorScript(proc, plan);
    }
  }
  const all = aggregateHealthCheckScript(plan);
  if (all) {
    scripts["all.sh"] = all;
  }
  return scripts;
}

function processHealthCheckScript(proc: Process): string {
  if (!proc.healthCheck) return "";
  const check = shellHealthCheck(proc.healthCheck);
  return (
    ["#!/bin/sh", `# Auto-generated health check for ${proc.name}`, "set -e", check].join("\n") +
    "\n"
  );
}

function processHealthMonitorScript(proc: Process, plan: Plan): string {
  if (!proc.healthCheck) return "";
  const interval = proc.healthCheck.interval || "5s";
  const retries = proc.healthCheck.retries ?? 3;
  const startPeriod = proc.healthCheck.startPeriod || "5s";
  const checkScript = shellQuote(`${generatedRuntimeDir(plan)}/healthchecks/${proc.name}.sh`);
  const config = shellQuote(`${generatedRuntimeDir(plan)}/supervisord.conf`);
  return (
    [
      "#!/bin/sh",
      `# Auto-generated health monitor for ${proc.name}`,
      `sleep ${startPeriod}`,
      "failures=0",
      "while true; do",
      `  if sh ${checkScript} >/dev/null 2>&1; then`,
      "    failures=0",
      "  else",
      "    failures=$((failures + 1))",
      `    if [ $failures -ge ${retries} ]; then`,
      `      supervisorctl -c ${config} restart ${proc.name}`,
      "      failures=0",
      "    fi",
      "  fi",
      `  sleep ${interval}`,
      "done",
    ].join("\n") + "\n"
  );
}

function aggregateHealthCheckScript(plan: Plan): string {
  const daemonProcesses = plan.runtime.processes.filter((p) => p.mode === "daemon");
  const checks = daemonProcesses
    .filter((p) => p.healthCheck)
    .map((p) => `sh ${shellQuote(`${generatedRuntimeDir(plan)}/healthchecks/${p.name}.sh`)}`);
  return (
    [
      "#!/bin/sh",
      "# Auto-generated aggregate health check",
      "set -e",
      `test -f ${shellQuote(`${generatedRuntimeDir(plan)}/ready`)}`,
      ...checks,
    ].join("\n") + "\n"
  );
}

function shellHealthCheck(hc: ProcessHealthCheck): string {
  const timeoutSeconds = parseDuration(hc.timeout, 3);
  switch (hc.type) {
    case "exec":
      if (hc.command && hc.command.length > 0) {
        return hc.command.map(shellQuote).join(" ");
      }
      return "true";
    case "tcp":
      return `nc -z -w ${timeoutSeconds} localhost ${hc.port || 80}`;
    default:
      return `curl -fsS --max-time ${timeoutSeconds} ${shellQuote(
        hc.url || `http://localhost:${hc.port || 80}`,
      )}`;
  }
}
