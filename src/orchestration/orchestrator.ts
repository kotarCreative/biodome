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
import { sourceRevision } from "./source.js";
import { emitProfileResolved } from "../core/profiles.js";

export interface OrchestrationResult extends TaskResult {
  run: RunRecord;
  compatibility: CompatibilityReport;
  executionPlanPath?: string;
  eventLogPath?: string;
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
    yield* emitProfileResolved(plan);
    const source = sourceRevision(rootDir);
    yield* eventStore.emit("source.resolved", source ?? {});

    let run = createRunRecord({
      runId: eventStore.runId,
      task: portablePlan.task.name,
      target: portablePlan.target.name,
      provider: driver.id,
      planDigest: executionPlanDigest(portablePlan),
      source,
      profile: plan.profile
        ? { name: plan.profile.name, fingerprint: plan.profile.fingerprint }
        : undefined,
    });
    yield* writeRunRecordEffect(rootDir, run);

    run = transitionRun(run, "preparing");
    yield* writeRunRecordEffect(rootDir, run);
    run = {
      ...run,
      attempts: [{ number: 1, startedAt: run.startedAt ?? new Date().toISOString() }],
    };
    yield* writeRunRecordEffect(rootDir, run);

    const observePhase = (phase: string) =>
      Effect.gen(function* () {
        if (phase === "ready" || phase === "executing" || phase === "collecting") {
          if (run.status !== phase) run = transitionRun(run, phase);
        }
        run = { ...run, phase };
        yield* writeRunRecordEffect(rootDir, run);
      });

    const result = yield* executeTask(rootDir, plan, driver, portablePlan, observePhase).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const outcome =
            error.timedOut || error.message.includes("timed out") ? "timed-out" : "failed";
          run = transitionRun(run, outcome);
          run = {
            ...run,
            outcome,
            cleanupStatus: error.cleanupFailed
              ? "failed"
              : portablePlan.task.cleanup === "always"
                ? "completed"
                : "not-requested",
            artifacts: (error.artifacts ?? []).map((artifact) => ({
              path: artifact.path,
              required: true,
              sizeBytes: artifact.sizeBytes,
              uri: artifact.localPath,
            })),
            attempts: run.attempts.map((attempt) => ({
              ...attempt,
              completedAt: new Date().toISOString(),
              error: error.message,
              exitCode: error.exitCode,
            })),
          };
          yield* writeRunRecordEffect(rootDir, run);
          run = transitionRun(run, "complete");
          yield* writeRunRecordEffect(rootDir, run);
          yield* eventStore.emit("action.result", {
            action: portablePlan.task.name,
            exitCode: error.exitCode ?? 1,
            artifacts: [...(error.artifacts ?? [])],
            error: error.message,
            cleanupFailed: error.cleanupFailed,
          });
          return yield* Effect.fail(error);
        }),
      ),
    );

    run = transitionRun(run, "succeeded");
    run = {
      ...run,
      outcome: "succeeded",
      cleanupStatus: result.cleanupFailed
        ? "failed"
        : portablePlan.task.cleanup !== "never"
          ? "completed"
          : "not-requested",
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
    run = transitionRun(run, "complete");
    yield* writeRunRecordEffect(rootDir, run);
    yield* eventStore.emit("action.result", {
      action: portablePlan.task.name,
      exitCode: result.exitCode,
      artifacts: result.artifacts ?? [],
      cleanupFailed: result.cleanupFailed,
    });
    return { ...result, run, compatibility, eventLogPath: eventStore.path };
  });
}
