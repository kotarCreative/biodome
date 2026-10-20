import { Effect } from "effect";
import { buildTargetPlanEffect } from "../builder/index.js";
import { PlanError, type SandboxError } from "../core/errors.js";
import type { Plan, RuntimeTarget } from "../core/plan.js";
import type { RuntimeDriver } from "../runtime/driver.js";
import { runtimeLayout, type RuntimeLayout } from "../runtime/layout.js";
import { getDriver } from "../runtime/registry.js";
import { emitProfileResolved } from "../core/profiles.js";

export interface TargetOperation {
  readonly rootDir: string;
  readonly plan: Plan;
  readonly target: RuntimeTarget;
  readonly driver: RuntimeDriver;
  readonly layout: RuntimeLayout;
  readonly deploymentId: string;
}

export interface TargetOperationDependencies {
  readonly buildTargetPlan: (
    rootDir: string,
    targetName: string,
    options?: { readonly dryRun?: boolean },
  ) => Effect.Effect<Plan, SandboxError>;
  readonly getDriver: (id: string) => Effect.Effect<RuntimeDriver, SandboxError>;
}

export const liveTargetOperationDependencies: TargetOperationDependencies = {
  buildTargetPlan: buildTargetPlanEffect,
  getDriver,
};

export function createTargetOperation(
  rootDir: string,
  targetName: string,
  options: { readonly dryRun?: boolean } = {},
  dependencies: TargetOperationDependencies = liveTargetOperationDependencies,
): Effect.Effect<TargetOperation, SandboxError> {
  return Effect.gen(function* () {
    const plan = yield* dependencies.buildTargetPlan(rootDir, targetName, options);
    const deployment = plan.deployment;
    // Target plans always carry deployment data; preserve a typed failure if that invariant changes.
    if (!deployment) {
      return yield* new PlanError({ message: `Target plan "${targetName}" has no deployment` });
    }
    const driver = yield* dependencies.getDriver(deployment.target.driver);
    yield* emitProfileResolved(plan);
    return {
      rootDir,
      plan,
      target: deployment.target,
      driver,
      layout: runtimeLayout(rootDir, deployment.target.name),
      deploymentId: deployment.deploymentId,
    };
  });
}

export function operationInput(operation: TargetOperation) {
  return {
    rootDir: operation.rootDir,
    outputDir: operation.layout.host.root,
    plan: operation.plan,
    target: operation.target,
    deploymentId: operation.deploymentId,
  };
}
