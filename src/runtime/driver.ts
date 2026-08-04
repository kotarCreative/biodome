import { Effect } from "effect";
import type { RuntimeError } from "../core/errors.js";
import type { EventStore } from "../core/events.js";
import type { Capabilities } from "../core/capabilities.js";
import type { Plan, RuntimeTarget } from "../core/plan.js";

export type DeploymentStatus = "pending" | "running" | "stopped" | "failed" | "unknown";

export interface RuntimeOperationInput {
  rootDir: string;
  outputDir: string;
  plan: Plan;
  target: RuntimeTarget;
  deploymentId: string;
}

export interface BuildResult {
  imageRef?: string;
  digest?: string;
}

export interface DeploymentState {
  driver: string;
  deploymentId: string;
  resourceIds: Record<string, string>;
  createdAt: string;
  schemaVersion?: number;
  target?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

export interface Artifact {
  path: string;
  sizeBytes: number;
  localPath: string;
}

export interface StatusResult {
  state: DeploymentStatus;
  message?: string;
}

export interface RuntimeDriver {
  readonly id: string;
  readonly capabilities: Capabilities;

  render(input: {
    rootDir: string;
    outputDir: string;
    plan: Plan;
    target: RuntimeTarget;
  }): Effect.Effect<string[], RuntimeError, never>;

  ensureAvailable(target: RuntimeTarget): Effect.Effect<void, RuntimeError, EventStore>;
  build(input: RuntimeOperationInput): Effect.Effect<BuildResult, RuntimeError, EventStore>;
  start(input: RuntimeOperationInput): Effect.Effect<DeploymentState, RuntimeError, EventStore>;
  stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore>;
  exec(
    input: RuntimeOperationInput & {
      command: string[];
      timeoutMs?: number;
      artifactPaths?: string[];
    },
  ): Effect.Effect<CommandResult, RuntimeError, EventStore>;
  collectArtifacts(
    input: RuntimeOperationInput & { paths: string[] },
  ): Effect.Effect<Artifact[], RuntimeError, EventStore>;
  status(input: RuntimeOperationInput): Effect.Effect<StatusResult, RuntimeError, EventStore>;
  logs(
    input: RuntimeOperationInput & { processName?: string },
  ): Effect.Effect<void, RuntimeError, EventStore>;
  restart(
    input: RuntimeOperationInput & { processName: string },
  ): Effect.Effect<void, RuntimeError, EventStore>;
}
