import { existsSync } from "node:fs";
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
import { RuntimeError, ValidationError } from "./errors.js";
import {
  supportsArtifacts,
  supportsBuild,
  supportsInplaceExec,
  supportsJob,
  supportsRender,
  supportsStart,
  supportsStatus,
  supportsStop,
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
import { agentTaskCommand } from "../agents/registry.js";
import type { ExecutionPlan } from "../orchestration/execution-plan.js";

export function harnessTaskCommand(plan: Plan, harnessName: string, prompt: string): string[] {
  return agentTaskCommand(plan, harnessName, prompt);
}

export interface TaskResult {
  exitCode: number;
  outputDir: string;
  durationMs: number;
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

function resolveHarnessCommand(plan: Plan, task: Task): Effect.Effect<string[], unknown> {
  return Effect.try({
    try: () => harnessTaskCommand(plan, task.harness, task.prompt),
    catch: (error) => {
      if (error instanceof ValidationError) {
        return new RuntimeError({ message: error.message });
      }
      return error;
    },
  });
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
    yield* driverOps.render(context);
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
) => Effect.Effect<CommandResult, RuntimeError, EventStore> {
  return (command, artifactPaths) => {
    if (supportsJob(driverOps)) {
      return instrumentOperation(
        store,
        scope,
        "job",
        commandMetadata(command),
        driverOps.runJob({ ...commandInput, command, timeoutMs, artifactPaths }),
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
): Effect.Effect<Artifact[], RuntimeError, EventStore> {
  if (!supportsArtifacts(driver)) {
    return Effect.fail(
      new RuntimeError({
        message: `Driver "${driver.id}" does not support artifact collection`,
      }),
    );
  }
  return Effect.gen(function* () {
    const collected = yield* driver.collectArtifacts({ ...commandInput, paths });
    return collected.map((a) => ({
      path: a.path,
      sizeBytes: a.sizeBytes,
      localPath: a.localPath,
    }));
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
): Effect.Effect<void, never, EventStore> {
  return cleanup.pipe(
    Effect.catch((cleanupError) =>
      Effect.logWarning(
        `Task cleanup failed for "${taskName}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      ).pipe(Effect.andThen(Effect.void)),
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

  const runEffect = Effect.gen(function* () {
    const cmd = yield* resolveHarnessCommand(plan, task);

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
        harness: task.harness,
      },
      scope,
    );

    const deployed = yield* ensureDeployed(driverOps, context, store, scope);
    const commandInput: TaskCommandInput = {
      ...context,
      state: deployed.state,
      buildManifest: deployed.buildManifest,
    };
    const runCommand = createCommandRunner(driverOps, commandInput, timeoutMs, store, scope);

    const execResult = yield* runCommand(cmd, task.artifacts);

    const durationMs = Date.now() - startTime;

    if (execResult.timedOut) {
      yield* store.emit(
        "task.failed",
        {
          target: targetName,
          driver: driver.id,
          task: task.name,
          harness: task.harness,
          durationMs,
          error: `timed out after ${task.timeout}`,
        },
        scope,
      );
      return yield* Effect.fail(
        new RuntimeError({
          message: `Task "${task.name}" timed out after ${task.timeout}`,
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
          harness: task.harness,
          durationMs,
          exitCode: execResult.exitCode,
          error: `exit code ${execResult.exitCode}`,
        },
        scope,
      );
      return yield* Effect.fail(
        new RuntimeError({
          message: `Task "${task.name}" failed with exit code ${execResult.exitCode}`,
        }),
      );
    }

    for (const validationCommand of task.validationCommands ?? []) {
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
            harness: task.harness,
            durationMs: Date.now() - startTime,
            exitCode: validation.exitCode,
            error: reason,
          },
          scope,
        );
        return yield* Effect.fail(new RuntimeError({ message: reason }));
      }
    }

    let taskArtifacts: Artifact[] | undefined;
    if (task.artifacts.length > 0) {
      taskArtifacts = yield* collectTaskArtifacts(driver, commandInput, task.artifacts);
    }

    yield* store.emit(
      "task.completed",
      {
        target: targetName,
        driver: driver.id,
        task: task.name,
        harness: task.harness,
        durationMs,
        exitCode: execResult.exitCode,
        artifacts: taskArtifacts,
      },
      scope,
    );

    return { exitCode: execResult.exitCode, outputDir, artifacts: taskArtifacts, durationMs };
  });

  const cleanup = createCleanupEffect(context, driver);
  return applyCleanupPolicy(
    runEffect,
    () => suppressCleanupFailure(cleanup, task.name),
    task.cleanup,
  );
}
