import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { parseDuration, type Plan, type RuntimeTarget, type Task } from "./plan.js";
import type { RuntimeDriver } from "../runtime/driver.js";
import { runtimeLayout } from "../runtime/layout.js";
import {
  statePath,
  readState,
  writeState,
  removeState,
  type DeploymentState,
} from "../runtime/state.js";
import {
  manifestFromBuildResult,
  writeBuildManifest,
  readBuildManifest,
  type BuildManifest,
} from "../runtime/build-manifest.js";
import { EventStore, commandMetadata, instrumentOperation, type EventScope } from "./events.js";
import { RuntimeError } from "./errors.js";
import {
  supportsArtifacts,
  supportsBuild,
  supportsInplaceExec,
  supportsJob,
  supportsRender,
  supportsStart,
  supportsStatus,
  supportsStop,
  supportsLogs,
} from "../runtime/driver.js";
import type {
  Artifact,
  BuildableDriver,
  CommandResult,
  RenderableDriver,
  RuntimeOperationInput,
  StartableDriver,
  StatusDriver,
  StoppableDriver,
} from "../runtime/driver.js";
import type { ExecutionPlan } from "../orchestration/execution-plan.js";
import { actionCommand } from "./action-command.js";
export { actionCommand } from "./action-command.js";

export interface TaskResult {
  exitCode: number;
  outputDir: string;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  cleanupFailed?: boolean;
  artifacts?: Array<{ path: string; sizeBytes: number; localPath: string }>;
}

export function shouldRunCleanup(policy: Task["cleanup"], exitCode: number): boolean {
  return policy === "always" || (policy === "on-success" && exitCode === 0);
}

/** Driver surface required to deploy a target and run tasks against it. */
type LifecycleCapableDriver = RuntimeDriver &
  RenderableDriver &
  BuildableDriver &
  StartableDriver &
  StoppableDriver &
  StatusDriver;

/** Inputs every driver operation receives for a single task run. */
interface TaskRunContext {
  readonly rootDir: string;
  readonly outputDir: string;
  readonly plan: Plan;
  readonly target: RuntimeTarget;
  readonly deploymentId: string;
  readonly executionPlan?: ExecutionPlan;
}

interface TaskCommandInput extends RuntimeOperationInput {
  readonly state: DeploymentState;
  readonly buildManifest: BuildManifest;
}

interface ResolvedDeployment {
  state: DeploymentState;
  buildManifest: ReturnType<typeof readBuildManifest>;
}

function ensureDriverCapabilities(
  driver: RuntimeDriver,
  requiresArtifacts: boolean,
): Effect.Effect<LifecycleCapableDriver, RuntimeError> {
  if (!supportsJob(driver) && !supportsInplaceExec(driver)) {
    return Effect.fail(
      new RuntimeError({
        message: `Driver "${driver.id}" does not support command execution`,
      }),
    );
  }

  if (requiresArtifacts && !supportsArtifacts(driver)) {
    return Effect.fail(
      new RuntimeError({
        message: `Driver "${driver.id}" does not support artifact collection`,
      }),
    );
  }

  if (!supportsRender(driver) || !supportsBuild(driver) || !supportsStart(driver)) {
    return Effect.fail(
      new RuntimeError({
        message: `Driver "${driver.id}" does not support lifecycle.build and lifecycle.start`,
      }),
    );
  }
  if (!supportsStop(driver) || !supportsStatus(driver)) {
    return Effect.fail(
      new RuntimeError({
        message: `Driver "${driver.id}" does not support lifecycle.stop and status.read`,
      }),
    );
  }
  const capable: LifecycleCapableDriver = driver;
  return Effect.succeed(capable);
}

function buildAndStartDeployment(
  driverOps: LifecycleCapableDriver,
  context: TaskRunContext,
  store: EventStore,
  scope: EventScope,
): Effect.Effect<ResolvedDeployment, RuntimeError, EventStore> {
  return Effect.gen(function* () {
    const targetName = context.target.name;
    const generated = yield* driverOps.render(context);
    yield* store.emit("files.generated", { rootDir: context.rootDir, files: generated }, scope);
    const buildResult = yield* instrumentOperation(
      store,
      scope,
      "build",
      { rootDir: context.rootDir },
      driverOps.build(context),
    );
    const manifest = manifestFromBuildResult({
      rootDir: context.rootDir,
      targetName,
      driver: driverOps.id,
      deploymentId: context.deploymentId,
      buildResult,
      contentId: buildResult.digest ?? context.deploymentId,
      provider: buildResult.provider,
    });
    writeBuildManifest(context.rootDir, targetName, manifest);
    const newState = yield* instrumentOperation(
      store,
      scope,
      "start",
      { rootDir: context.rootDir, build: true },
      driverOps.start({ ...context, buildManifest: manifest }),
    );
    writeState(context.rootDir, targetName, newState);
    return {
      state: readState(context.rootDir, targetName, context.deploymentId, driverOps.id),
      buildManifest: readBuildManifest(
        context.rootDir,
        targetName,
        context.deploymentId,
        driverOps.id,
      ),
    };
  });
}

function ensureDeployed(
  driverOps: LifecycleCapableDriver,
  context: TaskRunContext,
  store: EventStore,
  scope: EventScope,
): Effect.Effect<ResolvedDeployment, RuntimeError, EventStore> {
  const targetName = context.target.name;
  if (!existsSync(statePath(context.rootDir, targetName))) {
    return buildAndStartDeployment(driverOps, context, store, scope);
  }
  return Effect.gen(function* () {
    const existing = readState(context.rootDir, targetName, context.deploymentId, driverOps.id);
    const st = yield* instrumentOperation(
      store,
      scope,
      "status",
      {},
      driverOps.status({ ...context, state: existing }),
    );
    if (st.state === "running") {
      return {
        state: existing,
        buildManifest: readBuildManifest(
          context.rootDir,
          targetName,
          context.deploymentId,
          driverOps.id,
        ),
      };
    }
    yield* instrumentOperation(
      store,
      scope,
      "stop",
      { rootDir: context.rootDir },
      driverOps.stop({ ...context, state: existing }),
    );
    removeState(context.rootDir, targetName);
    return yield* buildAndStartDeployment(driverOps, context, store, scope);
  });
}

function createCommandRunner(
  driverOps: LifecycleCapableDriver,
  commandInput: TaskCommandInput,
  timeoutMs: number,
  store: EventStore,
  scope: EventScope,
): (
  command: string[],
  artifactPaths?: string[],
  validationCommands?: string[][],
) => Effect.Effect<CommandResult, RuntimeError, EventStore> {
  return (command, artifactPaths, validationCommands) => {
    if (supportsJob(driverOps)) {
      return instrumentOperation(
        store,
        scope,
        "job",
        commandMetadata(command),
        driverOps.runJob({
          ...commandInput,
          command,
          validationCommands,
          timeoutMs,
          artifactPaths,
        }),
      );
    }
    if (supportsInplaceExec(driverOps)) {
      return instrumentOperation(
        store,
        scope,
        "exec",
        commandMetadata(command),
        driverOps.exec({ ...commandInput, command, timeoutMs, artifactPaths }),
      );
    }
    return Effect.fail(
      new RuntimeError({
        message: `Driver "${driverOps.id}" does not support command execution`,
      }),
    );
  };
}

function collectTaskArtifacts(
  driver: RuntimeDriver,
  commandInput: TaskCommandInput,
  paths: string[],
  bestEffort = false,
): Effect.Effect<Artifact[], RuntimeError, EventStore> {
  if (!supportsArtifacts(driver)) {
    return Effect.fail(
      new RuntimeError({
        message: `Driver "${driver.id}" does not support artifact collection`,
      }),
    );
  }
  return Effect.gen(function* () {
    const store = yield* EventStore;
    const collected: Artifact[] = [];
    const failures: string[] = [];
    for (const path of paths) {
      const result = yield* Effect.result(
        driver.collectArtifacts({
          ...commandInput,
          paths: [path],
          artifactDir: join(commandInput.outputDir, "artifacts", store.runId),
        }),
      );
      if (result._tag === "Failure") {
        failures.push(result.failure.message);
        yield* store.emit("artifact.failed", { path, error: result.failure.message });
      } else {
        for (const artifact of result.success) {
          collected.push(artifact);
          yield* store.emit("artifact.collected", artifact);
        }
      }
    }
    if (!bestEffort && failures.length > 0)
      return yield* new RuntimeError({ message: failures.join("; "), artifacts: collected });
    return collected;
  });
}

function createCleanupEffect(
  context: TaskRunContext,
  driver: RuntimeDriver,
): Effect.Effect<void, RuntimeError, EventStore> {
  return Effect.gen(function* () {
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: context.target.name,
      provider: driver.id,
    };
    if (supportsStop(driver) && existsSync(statePath(context.rootDir, context.target.name))) {
      try {
        const validatedState = readState(
          context.rootDir,
          context.target.name,
          context.deploymentId,
          driver.id,
        );
        yield* instrumentOperation(
          store,
          scope,
          "stop",
          { rootDir: context.rootDir },
          driver.stop({ ...context, state: validatedState }),
        );
      } catch (readError) {
        yield* Effect.logWarning(
          `Failed to read deployment state during cleanup: ${readError instanceof Error ? readError.message : String(readError)}`,
        );
      }
    }
    removeState(context.rootDir, context.target.name);
  });
}

function suppressCleanupFailure(
  cleanup: Effect.Effect<void, RuntimeError, EventStore>,
  taskName: string,
  target: string,
  onFailure: () => void,
): Effect.Effect<void, never, EventStore> {
  return cleanup.pipe(
    Effect.tap(() =>
      Effect.gen(function* () {
        const store = yield* EventStore;
        yield* store.emit("cleanup.completed", { target });
      }),
    ),
    Effect.catch((cleanupError) =>
      Effect.gen(function* () {
        onFailure();
        const store = yield* EventStore;
        yield* store.emit("cleanup.failed", { target, error: cleanupError.message });
        yield* Effect.logWarning(
          `Task cleanup failed for "${taskName}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }),
    ),
  );
}

function applyCleanupPolicy(
  effect: Effect.Effect<TaskResult, unknown, EventStore>,
  runCleanup: () => Effect.Effect<void, never, EventStore>,
  policy: Task["cleanup"],
): Effect.Effect<TaskResult, RuntimeError, EventStore> {
  return effect.pipe(
    Effect.mapError((error) =>
      error instanceof RuntimeError ? error : new RuntimeError({ message: String(error) }),
    ),
    Effect.tap((result) => {
      if (shouldRunCleanup(policy, result.exitCode)) {
        return runCleanup();
      }
      return Effect.void;
    }),
    Effect.catch((error) => {
      if (policy === "always") {
        return runCleanup().pipe(Effect.andThen(Effect.fail(error)));
      }
      return Effect.fail(error);
    }),
  );
}

export function executeTask(
  rootDir: string,
  plan: Plan,
  driver: RuntimeDriver,
  executionPlan?: ExecutionPlan,
  onPhase?: (phase: string) => Effect.Effect<void, RuntimeError>,
): Effect.Effect<TaskResult, RuntimeError, EventStore> {
  const deployment = plan.deployment;
  const task = deployment?.task;
  if (!deployment || !task) {
    return Effect.fail(new RuntimeError({ message: "No task declared in plan" }));
  }

  const target = deployment.target;
  const targetName = target.name;
  const outputDir = runtimeLayout(rootDir, targetName).host.root;
  const deploymentId = deployment.deploymentId;
  const startTime = Date.now();
  const context: TaskRunContext = { rootDir, outputDir, plan, target, deploymentId, executionPlan };
  let evidenceInput: TaskCommandInput | undefined;
  let collectionAttempted = false;
  let cleanupFailed = false;
  const snapshotLogs = () =>
    Effect.gen(function* () {
      if (!evidenceInput || !supportsLogs(driver) || supportsJob(driver)) return;
      const processes = plan.runtime.processes.filter((process) => process.mode === "daemon");
      if (processes.length === 0) return;
      const store = yield* EventStore;
      for (const processName of [undefined, ...processes.map((process) => process.name)]) {
        yield* instrumentOperation(
          store,
          { runId: store.runId, target: targetName, provider: driver.id },
          "logs",
          { processName },
          driver.logs({ ...evidenceInput, processName, follow: false }),
        ).pipe(Effect.ignore);
      }
    });
  const phase = (value: string) =>
    Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.emit(
        "action.phase",
        { phase: value, action: task.name },
        { runId: store.runId, target: targetName, provider: driver.id },
      );
      if (onPhase) yield* onPhase(value);
    });

  const runEffect = Effect.gen(function* () {
    const cmd = actionCommand(task);
    yield* phase("preparing");

    const driverOps = yield* ensureDriverCapabilities(driver, task.artifacts.length > 0);
    const timeoutSeconds = parseDuration(task.timeout);
    const timeoutMs = timeoutSeconds * 1000;
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: targetName,
      provider: driver.id,
    };

    yield* store.emit(
      "task.started",
      {
        target: targetName,
        driver: driver.id,
        task: task.name,
      },
      scope,
    );

    const deployed = yield* ensureDeployed(driverOps, context, store, scope);
    yield* phase("ready");
    yield* store.emit(
      "environment.ready",
      { imageRef: deployed.buildManifest.imageRef, digest: deployed.buildManifest.digest },
      scope,
    );
    const commandInput: TaskCommandInput = {
      ...context,
      state: deployed.state,
      buildManifest: deployed.buildManifest,
    };
    evidenceInput = commandInput;
    yield* phase("executing");
    const runCommand = createCommandRunner(driverOps, commandInput, timeoutMs, store, scope);

    const usesOneShotJob = supportsJob(driverOps);
    const validationCommands = task.validationCommands ?? [];
    const execResult = yield* runCommand(
      cmd,
      task.artifacts,
      usesOneShotJob ? validationCommands : undefined,
    );

    const durationMs = Date.now() - startTime;

    if (execResult.timedOut) {
      yield* store.emit(
        "task.failed",
        {
          target: targetName,
          driver: driver.id,
          task: task.name,
          durationMs,
          error: `timed out after ${task.timeout}`,
        },
        scope,
      );
      return yield* Effect.fail(
        new RuntimeError({
          message: `Task "${task.name}" timed out after ${task.timeout}`,
          exitCode: execResult.exitCode,
          timedOut: true,
        }),
      );
    }

    if (execResult.exitCode !== 0) {
      yield* store.emit(
        "task.failed",
        {
          target: targetName,
          driver: driver.id,
          task: task.name,
          durationMs,
          exitCode: execResult.exitCode,
          error: `exit code ${execResult.exitCode}`,
        },
        scope,
      );
      return yield* Effect.fail(
        new RuntimeError({
          message: `Task "${task.name}" failed with exit code ${execResult.exitCode}`,
          exitCode: execResult.exitCode,
        }),
      );
    }

    for (const validationCommand of usesOneShotJob ? [] : validationCommands) {
      yield* phase("validating");
      const validation = yield* runCommand(validationCommand);
      if (validation.timedOut || validation.exitCode !== 0) {
        const reason = validation.timedOut
          ? `validation timed out: ${validationCommand.join(" ")}`
          : `validation failed with exit code ${validation.exitCode}: ${validationCommand.join(" ")}`;
        yield* store.emit(
          "task.failed",
          {
            target: targetName,
            driver: driver.id,
            task: task.name,
            durationMs: Date.now() - startTime,
            exitCode: validation.exitCode,
            error: reason,
          },
          scope,
        );
        return yield* Effect.fail(
          new RuntimeError({
            message: reason,
            exitCode: validation.exitCode,
            timedOut: validation.timedOut,
          }),
        );
      }
    }

    let taskArtifacts: Artifact[] | undefined;
    if (task.artifacts.length > 0) {
      yield* phase("collecting");
      collectionAttempted = true;
      taskArtifacts = yield* collectTaskArtifacts(driver, commandInput, task.artifacts);
    }

    yield* store.emit(
      "task.completed",
      {
        target: targetName,
        driver: driver.id,
        task: task.name,
        durationMs,
        exitCode: execResult.exitCode,
        artifacts: taskArtifacts,
      },
      scope,
    );
    yield* snapshotLogs();

    return {
      exitCode: execResult.exitCode,
      outputDir,
      artifacts: taskArtifacts,
      durationMs: Date.now() - startTime,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
    };
  });

  const withEvidence = runEffect.pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const error =
          cause instanceof RuntimeError ? cause : new RuntimeError({ message: String(cause) });
        let artifacts = error.artifacts ? [...error.artifacts] : [];
        if (evidenceInput && !collectionAttempted && task.artifacts.length > 0) {
          yield* phase("collecting");
          collectionAttempted = true;
          artifacts = yield* collectTaskArtifacts(driver, evidenceInput, task.artifacts, true);
        }
        yield* snapshotLogs();
        yield* phase(error.timedOut ? "timed-out" : "failed");
        return yield* new RuntimeError({
          message: error.message,
          command: error.command,
          exitCode: error.exitCode,
          timedOut: error.timedOut,
          artifacts,
        });
      }),
    ),
  );

  const cleanup = createCleanupEffect(context, driver);
  return applyCleanupPolicy(
    withEvidence,
    () =>
      phase("cleaning-up").pipe(
        Effect.ignore,
        Effect.andThen(
          suppressCleanupFailure(cleanup, task.name, targetName, () => {
            cleanupFailed = true;
          }),
        ),
      ),
    task.cleanup,
  ).pipe(
    Effect.map((result) => ({ ...result, cleanupFailed })),
    Effect.mapError(
      (error) =>
        new RuntimeError({
          message: error.message,
          command: error.command,
          exitCode: error.exitCode,
          timedOut: error.timedOut,
          artifacts: error.artifacts,
          cleanupFailed,
        }),
    ),
  );
}
