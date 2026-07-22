import { existsSync } from "node:fs";
import { Effect } from "effect";
import { parseDuration, type Plan } from "./plan.js";
import type { RuntimeDriver } from "../runtime/driver.js";
import { targetBuildDir } from "../runtime/output.js";
import { statePath, readState, writeState, removeState } from "../runtime/state.js";
import type { EventStore } from "./events.js";
import { RuntimeError, ValidationError } from "./errors.js";

function harnessCommand(plan: Plan, harnessName: string, prompt: string): string[] {
  const targetName = plan.deployment?.target.name;
  const harnessDir = targetName
    ? `/workspace/.biodome-build/targets/${targetName}`
    : "/workspace/.biodome-build";
  // Check Pi harness.
  const piHarness = plan.runtime.piHarnesses.find((h) => h.name === harnessName);
  if (piHarness) {
    return [`${harnessDir}/pi-homes/${piHarness.name}/pi`, "-p", prompt];
  }

  // Check Claude harness.
  const claudeHarness = plan.runtime.claudeHarnesses.find((h) => h.name === harnessName);
  if (claudeHarness) {
    return [`${harnessDir}/claude-homes/${claudeHarness.name}/claude`, "-p", prompt];
  }

  // Check Codex harness.
  const codexHarness = plan.runtime.codexHarnesses.find((h) => h.name === harnessName);
  if (codexHarness) {
    return ["codex", "-p", prompt];
  }

  // Check generic agent harness (OpenCode or others).
  const agentHarness = plan.runtime.agentHarnesses.find((h) => h.name === harnessName);
  if (agentHarness) {
    throw new RuntimeError({
      message: `Harness "${harnessName}" is an OpenCode harness which is not yet supported for task execution. Use a Codex, Claude, or Pi harness.`,
    });
  }

  throw new ValidationError({
    message: `Harness "${harnessName}" not found in plan`,
  });
}

export function executeTask(
  rootDir: string,
  plan: Plan,
  driver: RuntimeDriver,
): Effect.Effect<{ exitCode: number; outputDir: string }, RuntimeError, EventStore> {
  const task = plan.deployment?.task;
  if (!task) {
    return Effect.fail(new RuntimeError({ message: "No task declared in plan" }));
  }

  const targetName = plan.deployment!.target.name;
  const outputDir = targetBuildDir(rootDir, targetName);
  const deploymentId = plan.deployment!.deploymentId;

  const runEffect = Effect.gen(function* () {
    const deploymentStatePath = statePath(rootDir, targetName);

    // Render and start if needed.
    if (existsSync(deploymentStatePath)) {
      readState(rootDir, targetName, deploymentId);
    } else {
      yield* driver.render({ rootDir, outputDir, plan, target: plan.deployment!.target });
      yield* driver.build({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
      });
      const state = yield* driver.start({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
      });
      writeState(rootDir, targetName, state);
    }

    const cmd = harnessCommand(plan, task.harness, task.prompt);
    const result = yield* driver.exec({
      rootDir,
      outputDir,
      plan,
      target: plan.deployment!.target,
      deploymentId,
      command: cmd,
    });

    if (result.exitCode !== 0) {
      return yield* new RuntimeError({
        message: `Task "${task.name}" failed with exit code ${result.exitCode}`,
      });
    }

    if (task.artifacts.length > 0) {
      yield* driver.collectArtifacts({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
        paths: task.artifacts,
      });
    }

    return { exitCode: result.exitCode, outputDir };
  });

  const cleanupEffect = Effect.gen(function* () {
    if (task.cleanup === "always" || task.cleanup === "on-success") {
      yield* driver.stop({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
      });
      removeState(rootDir, targetName);
    }
  });

  const timedRun = Effect.raceFirst(
    runEffect,
    Effect.sleep(parseDuration(task.timeout) * 1000).pipe(
      Effect.andThen(
        Effect.fail(
          new RuntimeError({ message: `Task "${task.name}" timed out after ${task.timeout}` }),
        ),
      ),
    ),
  );

  return timedRun.pipe(
    Effect.tap((result) => {
      if (task.cleanup === "always" || (task.cleanup === "on-success" && result.exitCode === 0)) {
        return cleanupEffect;
      }
      return Effect.void;
    }),
    Effect.catch((error) => {
      if (task.cleanup === "always") {
        return cleanupEffect.pipe(Effect.andThen(Effect.fail(error)));
      }
      return Effect.fail(error);
    }),
  );
}
