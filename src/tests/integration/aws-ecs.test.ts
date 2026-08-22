import { describe, expect, it } from "vitest";
import {
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  StopTaskCommand,
  ECSClient,
} from "@aws-sdk/client-ecs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { createAwsEcsDriver } from "../../runtime/aws-ecs.js";
import {
  manifestFromBuildResult,
  writeBuildManifest,
  readBuildManifest,
} from "../../runtime/build-manifest.js";
import { runtimeLayout } from "../../runtime/layout.js";
import { removeState, readState, writeState } from "../../runtime/state.js";
import { createPlan, type Plan, type RuntimeTarget } from "../../core/plan.js";
import { NoOpEventStoreLive, type EventStore } from "../../core/events.js";
import type { RuntimeError } from "../../core/errors.js";

/**
 * Manually enabled end-to-end proof (Plan 05 step 15):
 *
 *   BIODOME_AWS_INTEGRATION=1 \
 *   BIODOME_ECS_CLUSTER=... \
 *   BIODOME_ECS_REPOSITORY=<account>.dkr.ecr.<region>.amazonaws.com/<repo> \
 *   BIODOME_ECS_SUBNETS=subnet-a,subnet-b BIODOME_ECS_SGS=sg-a \
 *   ECS_EXECUTION_ROLE_ARN=arn:aws:iam::<account>:role/... \
 *   npm run test:integration
 *
 * Builds, starts, observes, and stops a real Fargate task, then verifies every
 * created resource is released. The finally path re-stops so an assertion
 * failure never leaks a running task or task definition.
 */
const RUN = process.env.BIODOME_AWS_INTEGRATION === "1";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`BIODOME_AWS_INTEGRATION requires ${name} to be set`);
  return value;
}

function integrationTarget(): RuntimeTarget {
  return {
    name: "aws-integration",
    driver: "aws-ecs",
    options: {
      region: process.env.AWS_REGION ?? "us-east-1",
      cluster: requiredEnv("BIODOME_ECS_CLUSTER"),
      repository: requiredEnv("BIODOME_ECS_REPOSITORY"),
      executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
      subnets: requiredEnv("BIODOME_ECS_SUBNETS").split(",").filter(Boolean),
      securityGroups: process.env.BIODOME_ECS_SGS?.split(",").filter(Boolean) ?? [],
      assignPublicIp: true,
      cpu: 256,
      memoryMiB: 512,
    },
  };
}

function run<A>(effect: Effect.Effect<A, RuntimeError, EventStore>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(NoOpEventStoreLive("integration-run"))));
}

function operationInput(
  rootDir: string,
  outputDir: string,
  plan: Plan,
  target: RuntimeTarget,
  deploymentId: string,
) {
  return { rootDir, outputDir, plan, target, deploymentId };
}

describe.skipIf(!RUN)("aws-ecs opt-in integration", () => {
  it(
    "builds, starts, observes, stops, and leaves no resources behind",
    { timeout: 1_800_000 },
    async () => {
      const target = integrationTarget();
      const rootDir = join(tmpdir(), `biodome-ecs-integration-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      const layout = runtimeLayout(rootDir, target.name);
      const deploymentId = `int-${randomUUID().slice(0, 8)}`;
      const plan = createPlan("biodome-integration");
      const region = String(target.options.region);
      const cluster = String(target.options.cluster);
      const ecs = new ECSClient({ region });
      let startedTaskArn: string | undefined;

      try {
        const driver = createAwsEcsDriver();
        const input = operationInput(rootDir, layout.host.root, plan, target, deploymentId);

        // Availability preflight: docker daemon + AWS credentials.
        await run(driver.ensureAvailable(target));

        // Render and build the immutable image; the digest must be real.
        await run(driver.render(input));
        const buildResult = await run(driver.build({ ...input }));
        expect(buildResult.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(buildResult.imageRef).toBe(
          `${String(target.options.repository)}@${buildResult.digest}`,
        );

        const manifest = manifestFromBuildResult({
          rootDir,
          targetName: target.name,
          driver: "aws-ecs",
          deploymentId,
          buildResult,
          contentId: buildResult.digest ?? deploymentId,
        });
        writeBuildManifest(rootDir, target.name, manifest);

        // start() returns only once the task is RUNNING or failed terminally.
        const state = await run(
          driver.start({
            ...input,
            buildManifest: readBuildManifest(rootDir, target.name, deploymentId, "aws-ecs"),
          }),
        );
        startedTaskArn = state.resourceIds.taskArn;
        expect(state.status).toBe("running");
        expect(startedTaskArn).toMatch(/arn:aws:ecs:/);

        // Persist and re-read through the validated state module, mirroring
        // the production caller flow.
        writeState(rootDir, target.name, state);
        const validated = readState(rootDir, target.name, deploymentId, "aws-ecs");
        const statusInput = { ...input, state: validated };

        const describedRunning = await ecs.send(
          new DescribeTasksCommand({ cluster, tasks: [startedTaskArn] }),
        );
        expect(describedRunning.tasks?.[0]?.lastStatus).toBe("RUNNING");

        const status = await run(driver.status({ ...statusInput, buildManifest: manifest }));
        expect(status.state).toBe("running");

        // stop() must be idempotent and release the dedicated task definition.
        const stopInput = { ...statusInput, buildManifest: manifest };
        await run(driver.stop(stopInput));
        await run(driver.stop(stopInput));
        startedTaskArn = undefined;

        const afterStop = await ecs.send(
          new DescribeTasksCommand({
            cluster,
            tasks: [state.resourceIds.taskArn],
          }),
        );
        expect(["STOPPED", undefined]).toContain(afterStop.tasks?.[0]?.lastStatus);

        const taskDef = await ecs.send(
          new DescribeTaskDefinitionCommand({
            taskDefinition: state.resourceIds.taskDefinitionArn,
          }),
        );
        expect(taskDef.taskDefinition?.status).toBe("INACTIVE");
      } finally {
        if (startedTaskArn) {
          try {
            await ecs.send(
              new StopTaskCommand({
                cluster,
                task: startedTaskArn,
                reason: "biodome integration cleanup",
              }),
            );
          } catch {
            // Best-effort rollback; assertions above own failure reporting.
          }
        }
        rmSync(rootDir, { recursive: true, force: true });
        removeState(rootDir, target.name);
      }
    },
  );
});
