import { Effect } from "effect";
import { buildTaskPlanEffect } from "../../builder/index.js";
import { RuntimeError } from "../../core/errors.js";
import { orchestrateTask } from "../../orchestration/orchestrator.js";
import { compileExecutionPlan, providerProfile } from "../../orchestration/compiler.js";
import { validateCompatibility } from "../../orchestration/compatibility.js";
import { formatCompatibilityReport } from "../../orchestration/format.js";
import { getDriver } from "../../runtime/registry.js";
import { supportsAvailability } from "../../runtime/driver.js";

export function taskPlanWorkflow(rootDir: string, targetName: string, taskName: string) {
  return Effect.gen(function* () {
    const plan = yield* buildTaskPlanEffect(rootDir, targetName, taskName, { dryRun: true });
    const deployment = plan.deployment!;
    const driver = yield* getDriver(deployment.target.driver);
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

export function runTaskWorkflow(rootDir: string, targetName: string, taskName: string) {
  return Effect.gen(function* () {
    const plan = yield* buildTaskPlanEffect(rootDir, targetName, taskName);
    const deployment = plan.deployment!;
    const driver = yield* getDriver(deployment.target.driver);
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
    yield* driver.ensureAvailable(deployment.target);
    yield* Effect.sync(() =>
      console.log(`Running task "${taskName}" against sandbox "${targetName}"`),
    );
    return yield* orchestrateTask(rootDir, plan, driver);
  });
}
