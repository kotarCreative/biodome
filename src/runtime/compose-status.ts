export interface ServiceStatus {
  readonly name: string;
  readonly state: string;
  readonly health?: string;
}

export function parseServiceStatus(raw: unknown): ServiceStatus | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const name = typeof item.Service === "string" ? item.Service : undefined;
  const state = typeof item.State === "string" ? item.State : undefined;
  if (!name || !state) return undefined;
  const health = typeof item.Health === "string" ? item.Health : undefined;
  return { name, state, health };
}

// Docker Compose >= 2.21.0 emits `ps --format json` as JSON Lines (one object
// per line); older versions emit a single JSON array. Handle both, plus the
// empty-output case (no running services).
export function parseServiceStatusOutput(output: string): readonly ServiceStatus[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];

  const records: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);

  return records.map(parseServiceStatus).filter((s): s is ServiceStatus => s !== undefined);
}
