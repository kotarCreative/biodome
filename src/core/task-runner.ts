import { existsSync } from "node:fs";
import { Effect } from "effect";
import { parseDuration, type Plan } from "./plan.js";
import type { RuntimeDriver } from "../runtime/driver.js";
import { targetBuildDir } from "../runtime/output.js";
import { statePath, readState, writeState, removeState } from "../runtime/state.js";
import { EventStore } from "./events.js";
import { RuntimeError, ValidationError } from "./errors.js";
import { hasCapability } from "./capabilities.js";

export function harnessTaskCommand(plan: Plan, harnessName: string, prompt: string): string[] {
  const targetName = plan.deployment?.target.name;
  const harnessDir = targetName
    ? `/workspace/.biodome-build/targets/${targetName}`
    : "/workspace/.biodome-build";

  const piHarness = plan.runtime.piHarnesses.find((h) => h.name === harnessName);
  if (piHarness) {
    return [`${harnessDir}/pi-homes/${piHarness.name}/task`, prompt];
  }

  const claudeHarness = plan.runtime.claudeHarnesses.find((h) => h.name === harnessName);
  if (claudeHarness) {
    return [`${harnessDir}/claude-homes/${claudeHarness.name}/task`, prompt];
  }

  const codexHarness = plan.runtime.codexHarnesses.find((h) => h.name === harnessName);
  if (codexHarness) {
    return [`${harnessDir}/codex-homes/${codexHarness.name}/task`, prompt];
  }

  const agentHarness = plan.runtime.agentHarnesses.find((h) => h.name === harnessName);
  if (agentHarness) {
    return [`${harnessDir}/opencode-homes/${agentHarness.name}/task`, prompt];
  }

  throw new ValidationError({
    message: `Harness "${harnessName}" not found in plan`,
  });
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
): Effect.Effect<TaskResult, RuntimeError, EventStore> {
  const task = plan.deployment?.task;
  if (!task) {
    return Effect.fail(new RuntimeError({ message: "No task declared in plan" }));
  }

  const target = plan.deployment!.target;
  const targetName = target.name;
  const outputDir = targetBuildDir(rootDir, targetName);
  const deploymentId = plan.deployment!.deploymentId;
  const startTime = Date.now();

  const runEffect = Effect.gen(function* () {
    const input = { rootDir, outputDir, plan, target, deploymentId };

    const cmd = yield* Effect.try({
      try: () => harnessTaskCommand(plan, task.harness, task.prompt),
      catch: (error) => {
        if (error instanceof ValidationError) {
          return new RuntimeError({ message: error.message });
        }
        return error;
      },
    });

    if (!hasCapability(driver.capabilities, "exec.command")) {
      return yield* Effect.fail(
        new RuntimeError({
          message: `Driver "${driver.id}" does not support command execution`,
        }),
      );
    }

    if (task.artifacts.length > 0 && !hasCapability(driver.capabilities, "artifact.collect")) {
      return yield* Effect.fail(
        new RuntimeError({
          message: `Driver "${driver.id}" does not support artifact collection`,
        }),
      );
    }

    const timeoutSeconds = parseDuration(task.timeout);
    const timeoutMs = timeoutSeconds * 1000;
    const store = yield* EventStore;

    yield* store.emit("task.started", {
      target: targetName,
      driver: driver.id,
      task: task.name,
      harness: task.harness,
    });

    const stateFilePath = statePath(rootDir, targetName);

    if (existsSync(stateFilePath)) {
      readState(rootDir, targetName, deploymentId, driver.id);
      const st = yield* driver.status(input);
      if (st.state !== "running") {
        yield* driver.stop(input);
        removeState(rootDir, targetName);
        yield* driver.render(input);
        yield* driver.build(input);
        const newState = yield* driver.start(input);
        writeState(rootDir, targetName, newState);
      }
    } else {
      yield* driver.render(input);
      yield* driver.build(input);
      const newState = yield* driver.start(input);
      writeState(rootDir, targetName, newState);
    }

    const execResult = yield* driver.exec({
      ...input,
      command: cmd,
      timeoutMs,
      artifactPaths: task.artifacts,
    });

    const durationMs = Date.now() - startTime;

    if (execResult.timedOut) {
      yield* store.emit("task.failed", {
        target: targetName,
        driver: driver.id,
        task: task.name,
        harness: task.harness,
        durationMs,
        error: `timed out after ${task.timeout}`,
      });
      return yield* Effect.fail(
        new RuntimeError({
          message: `Task "${task.name}" timed out after ${task.timeout}`,
        }),
      );
    }

    if (execResult.exitCode !== 0) {
      yield* store.emit("task.failed", {
        target: targetName,
        driver: driver.id,
        task: task.name,
        harness: task.harness,
        durationMs,
        exitCode: execResult.exitCode,
        error: `exit code ${execResult.exitCode}`,
      });
      return yield* Effect.fail(
        new RuntimeError({
          message: `Task "${task.name}" failed with exit code ${execResult.exitCode}`,
        }),
      );
    }

    let taskArtifacts: TaskResult["artifacts"] = undefined;
    if (task.artifacts.length > 0) {
      const collected = yield* driver.collectArtifacts({ ...input, paths: task.artifacts });
      taskArtifacts = collected.map((a) => ({
        path: a.path,
        sizeBytes: a.sizeBytes,
        localPath: a.localPath,
      }));
    }

    yield* store.emit("task.completed", {
      target: targetName,
      driver: driver.id,
      task: task.name,
      harness: task.harness,
      durationMs,
      exitCode: execResult.exitCode,
      artifacts: taskArtifacts,
    });

    return { exitCode: execResult.exitCode, outputDir, artifacts: taskArtifacts, durationMs };
  });

  const cleanupEffect = Effect.gen(function* () {
    const input = { rootDir, outputDir, plan, target, deploymentId };
    yield* driver.stop(input);
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
