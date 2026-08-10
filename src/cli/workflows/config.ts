import { Effect } from "effect";
import {
  buildPlanEffect,
  buildTargetPlanEffect,
  validateFeaturesEffect,
  validatePlan,
} from "../../builder/index.js";
import { EventStore } from "../../core/events.js";

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

export function targetValidateWorkflow(rootDir: string, targetName: string) {
  return Effect.gen(function* () {
    const plan = yield* buildTargetPlanEffect(rootDir, targetName, { dryRun: true });
    yield* validatePlan(plan);
    const deployment = plan.deployment!;
    return { driver: deployment.target.driver, deploymentId: deployment.deploymentId };
  });
}
