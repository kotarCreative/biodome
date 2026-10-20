import { Effect } from "effect";
import { buildTaskPlanEffect } from "../../builder/index.js";
import { RuntimeError } from "../../core/errors.js";
import { orchestrateTask } from "../../orchestration/orchestrator.js";
import { compileExecutionPlan, providerProfile } from "../../orchestration/compiler.js";
import { validateCompatibility } from "../../orchestration/compatibility.js";
import { formatCompatibilityReport } from "../../orchestration/format.js";
import { getDriver } from "../../runtime/registry.js";
import { supportsAvailability, supportsTargetValidation } from "../../runtime/driver.js";
import { runtimeLayout } from "../../runtime/layout.js";
import type { Plan } from "../../core/plan.js";
import type { RuntimeDriver } from "../../runtime/driver.js";
import { TaskContextImpl } from "../../core/task-context.js";
import { EventStore } from "../../core/events.js";

export interface ActionOptions {
  readonly input?: Record<string, unknown>;
  readonly intent?: string;
  readonly outputs?: string[];
}

function applyInvocation(plan: Plan, options: ActionOptions): void {
  const task = plan.deployment?.task;
  if (!task) throw new Error("No action selected");
  const context = new TaskContextImpl(task.name);
  context.addAction({
    ...task,
    intent: options.intent ?? task.intent,
    input: { ...task.input, ...options.input },
    outputs: options.outputs ?? task.artifacts,
  });
  plan.deployment!.task = context.getTask();
}

function validateProviderTarget(rootDir: string, plan: Plan, driver: RuntimeDriver) {
  const deployment = plan.deployment!;
  return supportsTargetValidation(driver)
    ? driver.validateTarget({
        rootDir,
        outputDir: runtimeLayout(rootDir, deployment.target.name).host.root,
        plan,
        target: deployment.target,
      })
    : Effect.void;
}

export function taskPlanWorkflow(
  rootDir: string,
  targetName: string,
  taskName: string,
  options: ActionOptions = {},
) {
  return Effect.gen(function* () {
    const plan = yield* buildTaskPlanEffect(rootDir, targetName, taskName, { dryRun: true });
    yield* Effect.try({
      try: () => applyInvocation(plan, options),
      catch: (error) => new RuntimeError({ message: String(error) }),
    });
    const deployment = plan.deployment!;
    const driver = yield* getDriver(deployment.target.driver);
    yield* validateProviderTarget(rootDir, plan, driver);
    const executionPlan = compileExecutionPlan(plan);
    const compatibility = validateCompatibility(executionPlan, providerProfile(driver));
    return {
      executionPlan,
      compatibility,
      report: formatCompatibilityReport(compatibility),
      error: compatibility.compatible
        ? undefined
        : new RuntimeError({ message: "Target does not satisfy task requirements" }),
    };
  });
}

export function runTaskWorkflow(
  rootDir: string,
  targetName: string,
  taskName: string,
  options: ActionOptions = {},
) {
  return Effect.gen(function* () {
    const store = yield* EventStore;
    yield* store.emit("action.phase", { phase: "loading", action: taskName });
    const plan = yield* buildTaskPlanEffect(rootDir, targetName, taskName);
    yield* store.emit("plan.loaded", {
      project: plan.project,
      languages: plan.build.languageRequests.map((language) => language.name),
      services: plan.runtime.services.map((service) => service.name),
      processes: plan.runtime.processes.map((process) => process.name),
    });
    yield* Effect.try({
      try: () => applyInvocation(plan, options),
      catch: (error) => new RuntimeError({ message: String(error) }),
    });
    const deployment = plan.deployment!;
    const driver = yield* getDriver(deployment.target.driver);
    yield* validateProviderTarget(rootDir, plan, driver);
    const executionPlan = compileExecutionPlan(plan);
    const compatibility = validateCompatibility(executionPlan, providerProfile(driver));
    if (!compatibility.compatible) {
      return yield* new RuntimeError({
        message: `Target "${targetName}" does not satisfy task requirements: ${formatCompatibilityReport(compatibility)}`,
      });
    }
    if (!supportsAvailability(driver)) {
      return yield* new RuntimeError({
        message: `Driver "${driver.id}" does not support availability checks`,
      });
    }
    yield* store.emit("runtime.ensureAvailable", { backend: driver.id });
    yield* driver.ensureAvailable(deployment.target);
    return yield* orchestrateTask(rootDir, plan, driver);
  });
}
