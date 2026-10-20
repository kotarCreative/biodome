import { randomUUID } from "node:crypto";
import type { SourceRevision } from "./source.js";

export const RUN_RECORD_VERSION = 1;

export const RUN_STATES = [
  "planned",
  "preparing",
  "ready",
  "executing",
  "collecting",
  "succeeded",
  "failed",
  "timed-out",
  "cleaning-up",
  "complete",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface ProviderDeploymentReference {
  provider: string;
  resources: Record<string, string>;
  opaqueState?: unknown;
}

export interface RunArtifact {
  path: string;
  required: boolean;
  sizeBytes?: number;
  uri?: string;
}

export interface RunAttempt {
  number: number;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface RunRecord {
  version: typeof RUN_RECORD_VERSION;
  runId: string;
  task: string;
  target: string;
  provider: string;
  status: RunState;
  planDigest: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  deployment?: ProviderDeploymentReference;
  attempts: RunAttempt[];
  artifacts: RunArtifact[];
  source?: SourceRevision;
  phase?: string;
  outcome?: "succeeded" | "failed" | "timed-out";
  cleanupStatus?: "completed" | "failed" | "not-requested";
}

const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  planned: ["preparing", "failed"],
  preparing: ["ready", "failed", "cleaning-up"],
  ready: ["executing", "cleaning-up", "failed"],
  executing: ["collecting", "succeeded", "failed", "timed-out", "cleaning-up"],
  collecting: ["succeeded", "failed", "timed-out", "cleaning-up"],
  succeeded: ["cleaning-up", "complete"],
  failed: ["cleaning-up", "complete"],
  "timed-out": ["cleaning-up", "complete"],
  "cleaning-up": ["complete", "failed"],
  complete: [],
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionRun(
  record: RunRecord,
  status: RunState,
  at = new Date().toISOString(),
): RunRecord {
  if (!canTransitionRun(record.status, status)) {
    throw new Error(`Invalid run transition: ${record.status} -> ${status}`);
  }
  return {
    ...record,
    status,
    startedAt: status === "executing" ? (record.startedAt ?? at) : record.startedAt,
    completedAt: status === "complete" ? at : record.completedAt,
  };
}

export function createRunRecord(
  input: Omit<
    RunRecord,
    "version" | "runId" | "status" | "createdAt" | "attempts" | "artifacts"
  > & { runId?: string; createdAt?: string },
): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    runId: input.runId ?? randomUUID(),
    task: input.task,
    target: input.target,
    provider: input.provider,
    planDigest: input.planDigest,
    deployment: input.deployment,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: "planned",
    createdAt: input.createdAt ?? new Date().toISOString(),
    attempts: [],
    artifacts: [],
    ...(input.source ? { source: input.source } : {}),
  };
}
