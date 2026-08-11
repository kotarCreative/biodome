import type { Plan } from "../../core/plan.js";
import { runtimeLayout } from "../../runtime/layout.js";

/** Container root for generated runtime files, derived from the runtime layout. */
export function generatedRuntimeDir(plan?: Plan): string {
  return runtimeLayout("", plan?.deployment?.target.name).container.root;
}

export function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9_.\-/]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
