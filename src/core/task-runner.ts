import { existsSync } from "node:fs";
import { Effect } from "effect";
import { parseDuration, type Plan } from "./plan.js";
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
  BuildableDriver,
  RenderableDriver,
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

export function executeTask(
  rootDir: string,
  plan: Plan,
  driver: RuntimeDriver,
  executionPlan?: ExecutionPlan,
): Effect.Effect<TaskResult, RuntimeError, EventStore> {
  const task = plan.deployment?.task;
  if (!task) {
    return Effect.fail(new RuntimeError({ message: "No task declared in plan" }));
  }

  const target = plan.deployment!.target;
  const targetName = target.name;
  const outputDir = runtimeLayout(rootDir, targetName).host.root;
  const deploymentId = plan.deployment!.deploymentId;
  const startTime = Date.now();

  const runEffect = Effect.gen(function* () {
    const input = { rootDir, outputDir, plan, target, deploymentId, executionPlan };

    const cmd = yield* Effect.try({
      try: () => harnessTaskCommand(plan, task.harness, task.prompt),
      catch: (error) => {
        if (error instanceof ValidationError) {
          return new RuntimeError({ message: error.message });
        }
        return error;
      },
    });

    if (!supportsJob(driver) && !supportsInplaceExec(driver)) {
      return yield* Effect.fail(
        new RuntimeError({
          message: `Driver "${driver.id}" does not support command execution`,
        }),
      );
    }

    if (task.artifacts.length > 0 && !supportsArtifacts(driver)) {
      return yield* Effect.fail(
        new RuntimeError({
          message: `Driver "${driver.id}" does not support artifact collection`,
        }),
      );
    }

    if (!supportsRender(driver) || !supportsBuild(driver) || !supportsStart(driver)) {
      return yield* Effect.fail(
        new RuntimeError({
          message: `Driver "${driver.id}" does not support lifecycle.build and lifecycle.start`,
        }),
      );
    }
    if (!supportsStop(driver) || !supportsStatus(driver)) {
      return yield* Effect.fail(
        new RuntimeError({
          message: `Driver "${driver.id}" does not support lifecycle.stop and status.read`,
        }),
      );
    }
    const driverOps: RuntimeDriver &
      RenderableDriver &
      BuildableDriver &
      StartableDriver &
      StoppableDriver &
      StatusDriver = driver;
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

    const stateFilePath = statePath(rootDir, targetName);

    let state: DeploymentState;
    let buildManifest: ReturnType<typeof readBuildManifest>;
    if (existsSync(stateFilePath)) {
      const existing = readState(rootDir, targetName, deploymentId, driver.id);
      const st = yield* instrumentOperation(
        store,
        scope,
        "status",
        {},
        driverOps.status({ ...input, state: existing }),
      );
      if (st.state === "running") {
        state = existing;
        buildManifest = readBuildManifest(rootDir, targetName, deploymentId, driver.id);
      } else {
        yield* instrumentOperation(
          store,
          scope,
          "stop",
          { rootDir },
          driverOps.stop({ ...input, state: existing }),
        );
        removeState(rootDir, targetName);
        const deployed = yield* deploy();
        state = deployed.state;
        buildManifest = deployed.buildManifest;
      }
    } else {
      const deployed = yield* deploy();
      state = deployed.state;
      buildManifest = deployed.buildManifest;
    }

    function deploy(): Effect.Effect<
      { state: DeploymentState; buildManifest: ReturnType<typeof readBuildManifest> },
      RuntimeError,
      EventStore
    > {
      return Effect.gen(function* () {
        yield* driverOps.render(input);
        const buildResult = yield* instrumentOperation(
          store,
          scope,
          "build",
          { rootDir },
          driverOps.build(input),
        );
        const manifest = manifestFromBuildResult({
          rootDir,
          targetName,
          driver: driverOps.id,
          deploymentId,
          buildResult,
          contentId: buildResult.digest ?? deploymentId,
          provider: buildResult.provider,
        });
        writeBuildManifest(rootDir, targetName, manifest);
        const newState = yield* instrumentOperation(
          store,
          scope,
          "start",
          { rootDir, build: true },
          driverOps.start({ ...input, buildManifest: manifest }),
        );
        writeState(rootDir, targetName, newState);
        return {
          state: readState(rootDir, targetName, deploymentId, driverOps.id),
          buildManifest: readBuildManifest(rootDir, targetName, deploymentId, driverOps.id),
        };
      });
    }

    const commandInput = {
      ...input,
      state,
      buildManifest,
    };

    const runCommand = (
      command: string[],
      artifactPaths?: string[],
    ): Effect.Effect<{ exitCode: number; timedOut?: boolean }, RuntimeError, EventStore> => {
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

    let taskArtifacts: TaskResult["artifacts"] = undefined;
    if (task.artifacts.length > 0) {
      if (!supportsArtifacts(driver)) {
        return yield* Effect.fail(
          new RuntimeError({
            message: `Driver "${driver.id}" does not support artifact collection`,
          }),
        );
      }
      const collected = yield* driver.collectArtifacts({
        ...commandInput,
        paths: task.artifacts,
      });
      taskArtifacts = collected.map((a) => ({
        path: a.path,
        sizeBytes: a.sizeBytes,
        localPath: a.localPath,
      }));
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

  const cleanupEffect = Effect.gen(function* () {
    const input = { rootDir, outputDir, plan, target, deploymentId, executionPlan };
    const store = yield* EventStore;
    const scope: EventScope = { runId: store.runId, target: targetName, provider: driver.id };
    if (supportsStop(driver) && existsSync(statePath(rootDir, targetName))) {
      try {
        const validatedState = readState(rootDir, targetName, deploymentId, driver.id);
        yield* instrumentOperation(
          store,
          scope,
          "stop",
          { rootDir },
          driver.stop({ ...input, state: validatedState }),
        );
      } catch (readError) {
        yield* Effect.logWarning(
          `Failed to read deployment state during cleanup: ${readError instanceof Error ? readError.message : String(readError)}`,
        );
      }
    }
    removeState(rootDir, targetName);
  });

  function runCleanup(): Effect.Effect<void, never, EventStore> {
    return cleanupEffect.pipe(
      Effect.catch((cleanupError) =>
        Effect.logWarning(
          `Task cleanup failed for "${task!.name}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        ).pipe(Effect.andThen(Effect.void)),
      ),
    );
  }

  return runEffect.pipe(
    Effect.mapError((error) =>
      error instanceof RuntimeError ? error : new RuntimeError({ message: String(error) }),
    ),
    Effect.tap((result) => {
      if (task.cleanup === "always" || (task.cleanup === "on-success" && result.exitCode === 0)) {
        return runCleanup();
      }
      return Effect.void;
    }),
    Effect.catch((error) => {
      if (task.cleanup === "always") {
        return runCleanup().pipe(Effect.andThen(Effect.fail(error)));
      }
      return Effect.fail(error);
    }),
  );
}
