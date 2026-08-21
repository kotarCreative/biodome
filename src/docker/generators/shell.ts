import type { Plan } from "../../core/plan.js";
import { runtimeLayout } from "../../runtime/layout.js";

/** Container root for generated runtime files, derived from the runtime layout. */
export function generatedRuntimeDir(plan?: Plan): string {
  return runtimeLayout("", plan?.deployment?.target.name).container.root;
}

/** Environment variable through which supervised programs receive the log dir. */
export const SUPERVISOR_LOG_DIR_ENV = "BIODOME_LOG_DIR";

/**
 * Directory holding supervisord's own state (log, pidfile, socket) plus every
 * supervised process's stdout/stderr logs. Lives inside the generated runtime
 * dir so logs never touch world-writable /tmp; the generated startup script
 * creates it (mode 700) before supervisord launches. The biodome-mcp server
 * resolves the same directory at runtime from SUPERVISOR_LOG_DIR, which
 * generateSupervisordConf injects into each program's environment.
 */
export function supervisorLogDir(plan?: Plan): string {
  return `${generatedRuntimeDir(plan)}/logs`;
}

export function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9_.\-/]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function assertIdentifier(name: string, label = "name"): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(name)} must match ${IDENTIFIER_PATTERN.source}`,
    );
  }
  return name;
}

export function parseDuration(value: string | undefined, defaultSeconds: number): number {
  if (!value) return defaultSeconds;
  const match = value.match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!match) return defaultSeconds;
  const num = parseFloat(match[1]);
  const unit = match[2] || "s";
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return num * (multipliers[unit] || 1);
}

export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
