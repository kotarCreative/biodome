import { Effect } from "effect";
import { buildPlanEffect, validateFeaturesEffect, validatePlan } from "../../builder/index.js";
import { EventStore } from "../../core/events.js";
import { RuntimeError } from "../../core/errors.js";
import { createTargetOperation } from "../target-operation.js";
import type { TargetOperationDependencies } from "../target-operation.js";
import { providerProfile } from "../../orchestration/compiler.js";
import { preflightTargetCompatibility } from "../../orchestration/compatibility.js";

export function configValidateWorkflow(rootDir: string) {
  return Effect.gen(function* () {
    yield* validateFeaturesEffect(rootDir);
    const plan = yield* buildPlanEffect(rootDir, { dryRun: true });
    yield* validatePlan(plan);
    const store = yield* EventStore;
    yield* store.emit("config.validated", { project: plan.project, valid: true });
    return { message: "Configuration is valid" };
  });
}

export function targetValidateWorkflow(
  rootDir: string,
  targetName: string,
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(
      rootDir,
      targetName,
      { dryRun: true },
      dependencies,
    );
    const { plan, driver } = operation;
    yield* validatePlan(plan);
    const compatibility = preflightTargetCompatibility(plan, providerProfile(driver));
    if (!compatibility.compatible) {
      const details = compatibility.missing
        .map((issue) => `${issue.subject}${issue.reason ? ` (${issue.reason})` : ""}`)
        .join(", ");
      return yield* new RuntimeError({
        message: `Target "${targetName}" is incompatible with provider "${driver.id}": ${details}`,
      });
    }
    const deployment = plan.deployment!;
    return {
      driver: deployment.target.driver,
      deploymentId: deployment.deploymentId,
      compatibility,
    };
  });
}
