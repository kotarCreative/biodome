import { Effect } from "effect";
import type { Capabilities } from "../core/capabilities.js";
import { RuntimeError } from "../core/errors.js";
import type { EventStore } from "../core/events.js";
import type { Plan, RuntimeTarget } from "../core/plan.js";

export type DeploymentStatus = "pending" | "running" | "stopped" | "failed" | "unknown";

export interface RenderInput {
  rootDir: string;
  outputDir: string;
  plan: Plan;
  target: RuntimeTarget;
}

export interface RuntimeOperationInput extends RenderInput {
  deploymentId: string;
}

export interface ExecInput extends RuntimeOperationInput {
  command: string[];
  timeoutMs?: number;
  artifactPaths?: string[];
}

export interface ArtifactInput extends RuntimeOperationInput {
  paths: string[];
}

export interface LogInput extends RuntimeOperationInput {
  processName?: string;
}

export interface RestartInput extends RuntimeOperationInput {
  processName: string;
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

/** Identity and capability declaration shared by every runtime backend. */
export interface RuntimeDriver {
  readonly id: string;
  readonly capabilities: Capabilities;
}

export interface RenderableDriver {
  render(input: RenderInput): Effect.Effect<string[], RuntimeError, never>;
}

export interface AvailableDriver {
  ensureAvailable(target: RuntimeTarget): Effect.Effect<void, RuntimeError, EventStore>;
}

export interface BuildableDriver {
  build(input: RuntimeOperationInput): Effect.Effect<BuildResult, RuntimeError, EventStore>;
}

export interface StartableDriver {
  start(input: RuntimeOperationInput): Effect.Effect<DeploymentState, RuntimeError, EventStore>;
}

export interface StoppableDriver {
  stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore>;
}

export interface ExecutableDriver {
  exec(input: ExecInput): Effect.Effect<CommandResult, RuntimeError, EventStore>;
}

export interface ArtifactDriver {
  collectArtifacts(input: ArtifactInput): Effect.Effect<Artifact[], RuntimeError, EventStore>;
}

export interface StatusDriver {
  status(input: RuntimeOperationInput): Effect.Effect<StatusResult, RuntimeError, EventStore>;
}

export interface LogDriver {
  logs(input: LogInput): Effect.Effect<void, RuntimeError, EventStore>;
}

export interface RestartDriver {
  restart(input: RestartInput): Effect.Effect<void, RuntimeError, EventStore>;
}

function hasMethod(driver: object, method: string): boolean {
  return method in driver && typeof Reflect.get(driver, method) === "function";
}

export function supportsRender(driver: RuntimeDriver): driver is RuntimeDriver & RenderableDriver {
  return driver.capabilities.has("lifecycle.build") && hasMethod(driver, "render");
}

export function supportsAvailability(
  driver: RuntimeDriver,
): driver is RuntimeDriver & AvailableDriver {
  return hasMethod(driver, "ensureAvailable");
}

export function supportsBuild(driver: RuntimeDriver): driver is RuntimeDriver & BuildableDriver {
  return driver.capabilities.has("lifecycle.build") && hasMethod(driver, "build");
}

export function supportsStart(driver: RuntimeDriver): driver is RuntimeDriver & StartableDriver {
  return driver.capabilities.has("lifecycle.start") && hasMethod(driver, "start");
}

export function supportsStop(driver: RuntimeDriver): driver is RuntimeDriver & StoppableDriver {
  return driver.capabilities.has("lifecycle.stop") && hasMethod(driver, "stop");
}

export function supportsExec(driver: RuntimeDriver): driver is RuntimeDriver & ExecutableDriver {
  return driver.capabilities.has("exec.command") && hasMethod(driver, "exec");
}

export function supportsArtifacts(driver: RuntimeDriver): driver is RuntimeDriver & ArtifactDriver {
  return driver.capabilities.has("artifact.collect") && hasMethod(driver, "collectArtifacts");
}

export function supportsStatus(driver: RuntimeDriver): driver is RuntimeDriver & StatusDriver {
  return driver.capabilities.has("status.read") && hasMethod(driver, "status");
}

export function supportsLogs(driver: RuntimeDriver): driver is RuntimeDriver & LogDriver {
  return driver.capabilities.has("logs.stream") && hasMethod(driver, "logs");
}

export function supportsRestart(driver: RuntimeDriver): driver is RuntimeDriver & RestartDriver {
  return (
    (driver.capabilities.has("lifecycle.restart") || driver.capabilities.has("process.signal")) &&
    hasMethod(driver, "restart")
  );
}

type Operation =
  | "render"
  | "build"
  | "start"
  | "stop"
  | "exec"
  | "collectArtifacts"
  | "status"
  | "logs"
  | "restart";

const operationCapabilities: Readonly<Record<Operation, readonly string[]>> = {
  render: ["lifecycle.build"],
  build: ["lifecycle.build"],
  start: ["lifecycle.start"],
  stop: ["lifecycle.stop"],
  exec: ["exec.command"],
  collectArtifacts: ["artifact.collect"],
  status: ["status.read"],
  logs: ["logs.stream"],
  restart: ["lifecycle.restart", "process.signal"],
};

const operations = Object.keys(operationCapabilities) as Operation[];

/** Reject declarations that do not exactly match the runtime operation surface. */
export function validateRuntimeDriver(driver: RuntimeDriver): void {
  for (const operation of operations) {
    const capabilities = operationCapabilities[operation];
    const declared = capabilities.some((capability) => driver.capabilities.has(capability));
    const implemented = hasMethod(driver, operation);
    if (declared && !implemented) {
      throw new RuntimeError({
        message: `Runtime driver "${driver.id}" declares ${capabilities.join(" or ")} but does not implement ${operation}()`,
      });
    }
    if (implemented && !declared) {
      throw new RuntimeError({
        message: `Runtime driver "${driver.id}" implements ${operation}() without declaring ${capabilities.join(" or ")}`,
      });
    }
  }
}
