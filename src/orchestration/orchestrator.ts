import { Effect } from "effect";
import type { Plan } from "../core/plan.js";
import { RuntimeError } from "../core/errors.js";
import type { RuntimeDriver } from "../runtime/driver.js";
import { executeTask, type TaskResult } from "../core/task-runner.js";
import { compileExecutionPlan, executionPlanDigest, providerProfile } from "./compiler.js";
import { validateCompatibility, type CompatibilityReport } from "./compatibility.js";
import { createRunRecord, transitionRun, type RunRecord } from "./run-record.js";
import { writeRunRecordEffect } from "./run-store.js";
import { EventStore } from "../core/events.js";

export interface OrchestrationResult extends TaskResult {
  run: RunRecord;
  compatibility: CompatibilityReport;
  executionPlanPath?: string;
}

function incompatibilityMessage(report: CompatibilityReport): string {
  return report.missing
    .map((issue) => `${issue.subject}${issue.reason ? ` (${issue.reason})` : ""}`)
    .join(", ");
}

/** Provider-neutral preflight and durable run tracking around the legacy executor. */
export function orchestrateTask(
  rootDir: string,
  plan: Plan,
  driver: RuntimeDriver,
): Effect.Effect<OrchestrationResult, RuntimeError, EventStore> {
  return Effect.gen(function* () {
    const portablePlan = compileExecutionPlan(plan);
    const compatibility = validateCompatibility(portablePlan, providerProfile(driver));
    if (!compatibility.compatible) {
      return yield* new RuntimeError({
        message: `Target "${portablePlan.target.name}" is incompatible with task "${portablePlan.task.name}": ${incompatibilityMessage(compatibility)}`,
      });
    }

    const eventStore = yield* EventStore;

    let run = createRunRecord({
      runId: eventStore.runId,
      task: portablePlan.task.name,
      target: portablePlan.target.name,
      provider: driver.id,
      planDigest: executionPlanDigest(portablePlan),
    });
    yield* writeRunRecordEffect(rootDir, run);

    run = transitionRun(run, "preparing");
    yield* writeRunRecordEffect(rootDir, run);
    run = transitionRun(run, "ready");
    run = transitionRun(run, "executing");
    run = {
      ...run,
      attempts: [{ number: 1, startedAt: run.startedAt ?? new Date().toISOString() }],
    };
    yield* writeRunRecordEffect(rootDir, run);

    const result = yield* executeTask(rootDir, plan, driver, portablePlan).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          run = transitionRun(run, error.message.includes("timed out") ? "timed-out" : "failed");
          run = {
            ...run,
            attempts: run.attempts.map((attempt) => ({
              ...attempt,
              completedAt: new Date().toISOString(),
              error: error.message,
            })),
          };
          yield* writeRunRecordEffect(rootDir, run);
          if (portablePlan.task.cleanup === "always") run = transitionRun(run, "cleaning-up");
          run = transitionRun(run, "complete");
          yield* writeRunRecordEffect(rootDir, run);
          return yield* Effect.fail(error);
        }),
      ),
    );

    if (portablePlan.task.artifacts.length > 0) run = transitionRun(run, "collecting");
    run = transitionRun(run, "succeeded");
    run = {
      ...run,
      attempts: run.attempts.map((attempt) => ({
        ...attempt,
        completedAt: new Date().toISOString(),
        exitCode: result.exitCode,
      })),
      artifacts: portablePlan.task.artifacts.map((requirement) => {
        const artifact = result.artifacts?.find((candidate) => candidate.path === requirement.path);
        return {
          ...requirement,
          sizeBytes: artifact?.sizeBytes,
          uri: artifact?.localPath,
        };
      }),
    };
    yield* writeRunRecordEffect(rootDir, run);
    if (portablePlan.task.cleanup !== "never") run = transitionRun(run, "cleaning-up");
    run = transitionRun(run, "complete");
    yield* writeRunRecordEffect(rootDir, run);
    return { ...result, run, compatibility };
  });
}
