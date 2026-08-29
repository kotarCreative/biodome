import { describe, expect, it, vi } from "vitest";
import {
  DeregisterTaskDefinitionCommand,
  DeleteTaskDefinitionsCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { BatchDeleteImageCommand, ECRClient } from "@aws-sdk/client-ecr";
import { CloudWatchLogsClient, DeleteLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { removeState, readState, statePath, writeState } from "../../runtime/state.js";
import { createPlan, type Plan, type RuntimeTarget } from "../../core/plan.js";
import { NoOpEventStoreLive, type EventStore } from "../../core/events.js";
import type { RuntimeError } from "../../core/errors.js";
import { loadBiodomeEnv } from "../../cli/load-env.js";

/**
 * Manually enabled live AWS proof (Plan 05 step 15):
 *
 *   BIODOME_AWS_INTEGRATION=1 \
 *   AWS_REGION=us-east-1 \
 *   BIODOME_ECS_CLUSTER=... \
 *   BIODOME_ECS_REPOSITORY=<account>.dkr.ecr.<region>.amazonaws.com/<repo> \
 *   BIODOME_ECS_SUBNETS=subnet-a,subnet-b BIODOME_ECS_SGS=sg-a \
 *   ECS_EXECUTION_ROLE_ARN=arn:aws:iam::<account>:role/... \
 *   ECS_TASK_ROLE_ARN=arn:aws:iam::<account>:role/... \
 *   BIODOME_ECS_ARTIFACT_BUCKET=... \
 *   BIODOME_ECS_SENTINEL_SECRET_ARN=arn:aws:secretsmanager:... \
 *   npm run test:integration -- src/tests/integration/aws-ecs.test.ts
 *
 * Alternatively, place the same assignments in `.biodome/.env`; this test
 * loads that file without overwriting values already present in the process.
 *
 * The execution role must pull from ECR and write CloudWatch logs. The task
 * role must put objects under the configured bucket, while the test principal
 * must collect and delete those objects, manage ECS tasks/task definitions,
 * delete the generated ECR image, and delete the run-specific log group.
 * BIODOME_ECS_SENTINEL_SECRET_ARN must name a Secrets Manager secret or SSM
 * parameter that the execution role can read; the job verifies only that its
 * ECS-native value is non-empty and never prints it. The test principal also
 * needs ECR auth/push/delete, logs create/read/delete, iam:PassRole for both
 * roles, ECS lifecycle permissions, and S3 get/list/delete-version access.
 * Both roles must trust ecs-tasks.amazonaws.com.
 *
 * Cleanup owns the unique ECS families, ECR tag, CloudWatch log group, S3 keys,
 * and local root.
 */
loadBiodomeEnv();
const RUN = process.env.BIODOME_AWS_INTEGRATION === "1";
const TARGET_NAME = "aws-integration";

interface TrackedResources {
  ecsMayExist: boolean;
  ecrMayExist: boolean;
  logsMayExist: boolean;
  s3MayExist: boolean;
  readonly taskArns: Set<string>;
  readonly taskDefinitionArns: Set<string>;
  readonly taskDefinitionFamilies: Set<string>;
  readonly imageRefs: Set<string>;
  readonly logGroups: Set<string>;
  readonly referencedArns: Set<string>;
  readonly s3Objects: Array<{ bucket: string; key: string }>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`BIODOME_AWS_INTEGRATION requires ${name} to be set`);
  return value;
}

function requiredListEnv(name: string): string[] {
  const values = requiredEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`BIODOME_AWS_INTEGRATION requires ${name} to contain at least one value`);
  }
  return values;
}

function integrationTarget(artifactPrefix: string): RuntimeTarget {
  requiredEnv("ECS_EXECUTION_ROLE_ARN");
  requiredEnv("ECS_TASK_ROLE_ARN");
  requiredEnv("BIODOME_ECS_ARTIFACT_BUCKET");

  return {
    name: TARGET_NAME,
    driver: "aws-ecs",
    options: {
      region: requiredEnv("AWS_REGION"),
      cluster: requiredEnv("BIODOME_ECS_CLUSTER"),
      repository: requiredEnv("BIODOME_ECS_REPOSITORY"),
      executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
      taskRoleArn: { env: "ECS_TASK_ROLE_ARN" },
      artifactBucket: { env: "BIODOME_ECS_ARTIFACT_BUCKET" },
      artifactPrefix,
      workspace: { strategy: "upload" },
      subnets: requiredListEnv("BIODOME_ECS_SUBNETS"),
      securityGroups: requiredListEnv("BIODOME_ECS_SGS"),
      assignPublicIp: process.env.BIODOME_ECS_ASSIGN_PUBLIC_IP !== "0",
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

function trackRequired(set: Set<string>, value: string | undefined, description: string): string {
  if (!value) throw new Error(`AWS did not return ${description}`);
  set.add(value);
  return value;
}

function taskDefinitionFamily(arn: string): string | undefined {
  return /:task-definition\/([^:]+):\d+$/.exec(arn)?.[1];
}

async function listTaskDefinitionArns(
  ecs: ECSClient,
  family: string,
  status: "ACTIVE" | "INACTIVE",
): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await ecs.send(
      new ListTaskDefinitionsCommand({
        familyPrefix: family,
        status,
        sort: "DESC",
        nextToken,
      }),
    );
    arns.push(
      ...(response.taskDefinitionArns ?? []).filter((arn) => taskDefinitionFamily(arn) === family),
    );
    nextToken = response.nextToken;
  } while (nextToken);
  return arns;
}

async function listTaskArns(
  ecs: ECSClient,
  cluster: string,
  family: string,
  desiredStatus: "RUNNING" | "STOPPED",
): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await ecs.send(
      new ListTasksCommand({ cluster, family, desiredStatus, nextToken }),
    );
    arns.push(...(response.taskArns ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return arns;
}

async function waitForFamilyResources(
  ecs: ECSClient,
  cluster: string,
  family: string,
  tracked: TrackedResources,
): Promise<{ taskDefinitionArns: string[]; taskArns: string[] }> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [activeTaskDefinitionArns, inactiveTaskDefinitionArns, taskArns] = await Promise.all([
      listTaskDefinitionArns(ecs, family, "ACTIVE"),
      listTaskDefinitionArns(ecs, family, "INACTIVE"),
      listTaskArns(ecs, cluster, family, "STOPPED"),
    ]);
    const describedTasks =
      taskArns.length > 0
        ? await ecs.send(new DescribeTasksCommand({ cluster, tasks: taskArns }))
        : { tasks: [] };
    const taskDefinitionArns = [
      ...activeTaskDefinitionArns,
      ...inactiveTaskDefinitionArns,
      ...(describedTasks.tasks ?? [])
        .map((task) => task.taskDefinitionArn)
        .filter((arn): arn is string => typeof arn === "string"),
    ];
    for (const arn of taskDefinitionArns) tracked.taskDefinitionArns.add(arn);
    for (const arn of taskArns) tracked.taskArns.add(arn);
    if (taskDefinitionArns.length > 0 && taskArns.length > 0) {
      return { taskDefinitionArns, taskArns };
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out discovering stopped ECS resources for family ${family}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function waitForStopped(ecs: ECSClient, cluster: string, taskArn: string): Promise<void> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const response = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
    const task = response.tasks?.[0];
    const failures = response.failures ?? [];
    const missing =
      failures.length > 0 && failures.every((failure) => failure.reason === "MISSING");
    if (!task && missing) return;
    if (task?.lastStatus === "STOPPED") return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ECS task ${taskArn} to stop`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function waitForLogMarker(
  driver: ReturnType<typeof createAwsEcsDriver>,
  input: Parameters<ReturnType<typeof createAwsEcsDriver>["logs"]>[0],
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const messages: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...values) => {
      messages.push(values.map(String).join(" "));
    });
    try {
      await run(driver.logs(input));
    } finally {
      logSpy.mockRestore();
    }
    if (messages.some((message) => message.includes(marker))) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for CloudWatch log marker ${marker}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function cleanupTrackedResources(input: {
  ecs: ECSClient;
  ecr: ECRClient;
  cloudwatch: CloudWatchLogsClient;
  s3: S3Client;
  cluster: string;
  repository: string;
  rootDir: string;
  targetName: string;
  deploymentId: string;
  tracked: TrackedResources;
}): Promise<void> {
  const errors: Error[] = [];
  const attempt = async (description: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      errors.push(
        new Error(`${description}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  };

  if (existsSync(statePath(input.rootDir, input.targetName))) {
    await attempt("track persisted ECS state", async () => {
      const state = readState(input.rootDir, input.targetName, input.deploymentId, "aws-ecs");
      if (state.resourceIds.taskArn) input.tracked.taskArns.add(state.resourceIds.taskArn);
      if (state.resourceIds.taskDefinitionArn) {
        input.tracked.taskDefinitionArns.add(state.resourceIds.taskDefinitionArn);
      }
    });
  }

  if (input.tracked.ecsMayExist) {
    // Lost SDK responses and ECS propagation can hide newly-created resources
    // from the first list call. Reconcile each unique family repeatedly.
    for (let attemptNumber = 0; attemptNumber < 6; attemptNumber++) {
      for (const family of input.tracked.taskDefinitionFamilies) {
        await attempt(`discover ECS tasks for ${family}`, async () => {
          const arns = (
            await Promise.all(
              (["RUNNING", "STOPPED"] as const).map((status) =>
                listTaskArns(input.ecs, input.cluster, family, status),
              ),
            )
          ).flat();
          for (const arn of arns) input.tracked.taskArns.add(arn);
        });
      }
      if (attemptNumber < 5) await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  for (const taskArn of input.tracked.taskArns) {
    await attempt(`stop ECS task ${taskArn}`, async () => {
      const response = await input.ecs.send(
        new DescribeTasksCommand({ cluster: input.cluster, tasks: [taskArn] }),
      );
      const task = response.tasks?.[0];
      const failures = response.failures ?? [];
      const missing =
        failures.length > 0 && failures.every((failure) => failure.reason === "MISSING");
      if (!task && missing) return;
      if (!task) {
        throw new Error(`DescribeTasks returned no task and no MISSING failure for ${taskArn}`);
      }
      if (task.lastStatus !== "STOPPED") {
        await input.ecs.send(
          new StopTaskCommand({
            cluster: input.cluster,
            task: taskArn,
            reason: "biodome integration cleanup",
          }),
        );
      }
    });
  }

  for (const taskArn of input.tracked.taskArns) {
    await attempt(`wait for ECS task ${taskArn} to stop`, () =>
      waitForStopped(input.ecs, input.cluster, taskArn),
    );
  }

  if (input.tracked.ecsMayExist) {
    for (let attemptNumber = 0; attemptNumber < 6; attemptNumber++) {
      for (const family of input.tracked.taskDefinitionFamilies) {
        await attempt(`discover ECS task definitions for ${family}`, async () => {
          const arns = (
            await Promise.all(
              (["ACTIVE", "INACTIVE"] as const).map((status) =>
                listTaskDefinitionArns(input.ecs, family, status),
              ),
            )
          ).flat();
          for (const arn of arns) input.tracked.taskDefinitionArns.add(arn);
        });
      }
      if (attemptNumber < 5) await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  for (const taskDefinitionArn of input.tracked.taskDefinitionArns) {
    await attempt(`deregister ECS task definition ${taskDefinitionArn}`, async () => {
      const response = await input.ecs
        .send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }))
        .catch((error: unknown) => {
          if (error instanceof Error && /not found|does not exist/i.test(error.message)) {
            return undefined;
          }
          throw error;
        });
      if (!response) return;
      if (response.taskDefinition?.status === "ACTIVE") {
        await input.ecs.send(
          new DeregisterTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }),
        );
      }
      const deleted = await input.ecs.send(
        new DeleteTaskDefinitionsCommand({ taskDefinitions: [taskDefinitionArn] }),
      );
      const failures = (deleted.failures ?? []).filter((failure) => failure.reason !== "MISSING");
      if (failures.length > 0) {
        throw new Error(
          failures.map((failure) => failure.reason ?? failure.detail ?? "unknown").join("; "),
        );
      }
    });
  }

  if (input.tracked.s3MayExist) {
    for (const object of input.tracked.s3Objects) {
      await attempt(`delete s3://${object.bucket}/${object.key}`, async () => {
        await input.s3.send(new DeleteObjectCommand({ Bucket: object.bucket, Key: object.key }));
        let keyMarker: string | undefined;
        let versionIdMarker: string | undefined;
        do {
          const versions = await input.s3.send(
            new ListObjectVersionsCommand({
              Bucket: object.bucket,
              Prefix: object.key,
              KeyMarker: keyMarker,
              VersionIdMarker: versionIdMarker,
            }),
          );
          const versionedObjects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]
            .filter((entry) => entry.Key === object.key && entry.VersionId)
            .map((entry) => ({ Key: object.key, VersionId: entry.VersionId }));
          if (versionedObjects.length > 0) {
            await input.s3.send(
              new DeleteObjectsCommand({
                Bucket: object.bucket,
                Delete: { Objects: versionedObjects, Quiet: true },
              }),
            );
          }
          keyMarker = versions.IsTruncated ? versions.NextKeyMarker : undefined;
          versionIdMarker = versions.IsTruncated ? versions.NextVersionIdMarker : undefined;
        } while (keyMarker);
      });
    }
  }

  if (input.tracked.ecrMayExist) {
    await attempt(`delete ECR image tag ${input.deploymentId}`, async () => {
      const repositoryName = input.repository.slice(input.repository.indexOf("/") + 1);
      const registryId = /^(\d{12})\.dkr\.ecr[.-]/.exec(input.repository)?.[1];
      if (!repositoryName || repositoryName === input.repository) {
        throw new Error(`Cannot derive an ECR repository name from ${input.repository}`);
      }
      const response = await input.ecr.send(
        new BatchDeleteImageCommand({
          registryId,
          repositoryName,
          imageIds: [{ imageTag: input.deploymentId }],
        }),
      );
      const failures = (response.failures ?? []).filter(
        (failure) => failure.failureCode !== "ImageNotFound",
      );
      if (failures.length > 0) {
        throw new Error(
          failures
            .map((failure) => `${failure.failureCode ?? "unknown"}: ${failure.failureReason ?? ""}`)
            .join("; "),
        );
      }
    });
  }

  if (input.tracked.logsMayExist) {
    for (const logGroupName of input.tracked.logGroups) {
      await attempt(`delete CloudWatch log group ${logGroupName}`, async () => {
        try {
          await input.cloudwatch.send(new DeleteLogGroupCommand({ logGroupName }));
        } catch (error) {
          if (error instanceof Error && error.name === "ResourceNotFoundException") return;
          throw error;
        }
      });
    }
  }

  await attempt("remove local deployment state", async () => {
    removeState(input.rootDir, input.targetName);
  });
  await attempt("remove local integration root", async () => {
    rmSync(input.rootDir, { recursive: true, force: true });
  });

  if (errors.length > 0) {
    throw new AggregateError(errors, "AWS ECS integration cleanup failed");
  }
}

describe.skipIf(!RUN)("aws-ecs opt-in integration", () => {
  it(
    "proves immutable workspace, job, artifact, logs, and lifecycle behavior",
    { timeout: 1_800_000 },
    async () => {
      const runId = randomUUID().replaceAll("-", "").slice(0, 16);
      const deploymentId = `int-${runId}`;
      const artifactPrefix = `biodome-integration/${runId}`;
      const projectName = `biodome-integration-${runId}`;
      const artifactPath = `proof/${runId}.txt`;
      const artifactBucket = requiredEnv("BIODOME_ECS_ARTIFACT_BUCKET");
      const repository = requiredEnv("BIODOME_ECS_REPOSITORY");
      const artifactKey = `${artifactPrefix}/${deploymentId}/${artifactPath}`;
      const markerFile = `biodome-repository-marker-${runId}.txt`;
      const marker = `biodome-aws-marker-${randomUUID()}`;
      const jobName = "workspace-artifact-proof";
      const logMarker = `biodome-job-complete:${jobName}:${runId}`;
      const expectedArtifact = `${marker}\n${jobName}\n`;
      const sentinelSecretArn = requiredEnv("BIODOME_ECS_SENTINEL_SECRET_ARN");
      const target = integrationTarget(artifactPrefix);
      const region = String(target.options.region);
      const cluster = String(target.options.cluster);
      const rootDir = join(tmpdir(), `biodome-ecs-integration-${runId}`);
      const layout = runtimeLayout(rootDir, target.name);
      const deploymentFamily = `biodome-${deploymentId}`;
      const jobFamily = `${deploymentFamily}-exec`;
      const tracked: TrackedResources = {
        ecsMayExist: false,
        ecrMayExist: false,
        logsMayExist: false,
        s3MayExist: false,
        taskArns: new Set(),
        taskDefinitionArns: new Set(),
        taskDefinitionFamilies: new Set([deploymentFamily, jobFamily]),
        imageRefs: new Set(),
        logGroups: new Set([`/biodome/${projectName}/${TARGET_NAME}`]),
        referencedArns: new Set([
          requiredEnv("ECS_EXECUTION_ROLE_ARN"),
          requiredEnv("ECS_TASK_ROLE_ARN"),
        ]),
        s3Objects: [{ bucket: artifactBucket, key: artifactKey }],
      };
      const ecs = new ECSClient({ region });
      const ecr = new ECRClient({ region });
      const cloudwatch = new CloudWatchLogsClient({ region });
      const s3 = new S3Client({ region });

      tracked.referencedArns.add(sentinelSecretArn);

      try {
        mkdirSync(rootDir, { recursive: true });
        writeFileSync(join(rootDir, markerFile), `${marker}\n`, { mode: 0o600 });

        const driver = createAwsEcsDriver();
        const plan = createPlan(projectName);
        plan.deployment = {
          target,
          deploymentId,
          task: {
            name: jobName,
            harness: "aws-integration",
            prompt: "Prove the uploaded workspace and AWS-native task contracts.",
            artifacts: [artifactPath],
            timeout: "10m",
            cleanup: "never",
            network: { mode: "egress" },
            workspace: { strategy: "upload" },
          },
        };
        plan.runtime.processes.push({
          name: "keepalive",
          command: ["sleep", "infinity"],
          ports: [],
          environment: {},
          mode: "daemon",
          startOn: "start.post",
        });
        plan.runtime.environment = {
          BIODOME_INTEGRATION_ARTIFACT_PATH: artifactPath,
          BIODOME_INTEGRATION_EXPECT_SECRET: "1",
          BIODOME_INTEGRATION_JOB_NAME: jobName,
          BIODOME_INTEGRATION_LOG_MARKER: logMarker,
          BIODOME_INTEGRATION_MARKER: marker,
          BIODOME_INTEGRATION_MARKER_FILE: markerFile,
        };
        plan.runtime.envVars.push({
          key: "BIODOME_INTEGRATION_SENTINEL",
          scope: "runtime",
          from: { secretArn: sentinelSecretArn },
          required: true,
        });

        const input = operationInput(rootDir, layout.host.root, plan, target, deploymentId);

        // Availability preflight: Docker daemon plus usable AWS credentials.
        await run(driver.ensureAvailable(target));

        // Deployment metadata activates COPY . workspace materialization.
        await run(driver.render(input));
        const dockerfile = readFileSync(join(layout.host.root, "Dockerfile"), "utf-8");
        expect(plan.deployment.target.driver).toBe("aws-ecs");
        expect(dockerfile).toContain("COPY . /workspace/");

        tracked.ecrMayExist = true;
        const buildResult = await run(driver.build(input));
        const imageRef = trackRequired(
          tracked.imageRefs,
          buildResult.imageRef,
          "an image reference",
        );
        expect(buildResult.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(imageRef).toBe(`${String(target.options.repository)}@${buildResult.digest}`);

        const manifest = manifestFromBuildResult({
          rootDir,
          targetName: target.name,
          driver: "aws-ecs",
          deploymentId,
          buildResult,
          contentId: buildResult.digest ?? deploymentId,
        });
        writeBuildManifest(rootDir, target.name, manifest);
        const persistedManifest = readBuildManifest(rootDir, target.name, deploymentId, "aws-ecs");

        tracked.ecsMayExist = true;
        tracked.logsMayExist = true;
        const state = await run(driver.start({ ...input, buildManifest: persistedManifest }));
        const startedTaskArn = trackRequired(
          tracked.taskArns,
          state.resourceIds.taskArn,
          "a deployment task ARN",
        );
        const deploymentTaskDefinitionArn = trackRequired(
          tracked.taskDefinitionArns,
          state.resourceIds.taskDefinitionArn,
          "a deployment task definition ARN",
        );
        trackRequired(tracked.logGroups, state.resourceIds.logGroup, "a CloudWatch log group");
        expect(state.status).toBe("running");

        // Mirror the caller's validated state flow and make the local resource
        // identity recoverable before any subsequent AWS assertion.
        writeState(rootDir, target.name, state);
        const validated = readState(rootDir, target.name, deploymentId, "aws-ecs");
        const statusInput = { ...input, state: validated, buildManifest: manifest };

        // A RUNNING transition alone can precede container startup failures.
        // Remaining alive after supervisor starts proves a viable deployment.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const describedRunning = await ecs.send(
          new DescribeTasksCommand({ cluster, tasks: [startedTaskArn] }),
        );
        expect(describedRunning.tasks?.[0]?.lastStatus).toBe("RUNNING");

        const deploymentTaskDefinition = await ecs.send(
          new DescribeTaskDefinitionCommand({ taskDefinition: deploymentTaskDefinitionArn }),
        );
        const registeredDeploymentArn = trackRequired(
          tracked.taskDefinitionArns,
          deploymentTaskDefinition.taskDefinition?.taskDefinitionArn,
          "the registered deployment task definition ARN",
        );
        expect(registeredDeploymentArn).toBe(deploymentTaskDefinitionArn);
        expect(deploymentTaskDefinition.taskDefinition?.containerDefinitions?.[0]?.image).toBe(
          imageRef,
        );
        expect(imageRef).toMatch(/@sha256:[a-f0-9]{64}$/);

        const status = await run(driver.status(statusInput));
        expect(status.state).toBe("running");

        const jobScript = [
          "set -eu",
          'test "$(cat "/workspace/$BIODOME_INTEGRATION_MARKER_FILE")" = "$BIODOME_INTEGRATION_MARKER"',
          'if [ "$BIODOME_INTEGRATION_EXPECT_SECRET" = "1" ]; then test -n "${BIODOME_INTEGRATION_SENTINEL:-}"; fi',
          "artifact_dir=${BIODOME_INTEGRATION_ARTIFACT_PATH%/*}",
          'mkdir -p "/workspace/$artifact_dir"',
          'printf "%s\\n%s\\n" "$BIODOME_INTEGRATION_MARKER" "$BIODOME_INTEGRATION_JOB_NAME" > "/workspace/$BIODOME_INTEGRATION_ARTIFACT_PATH"',
          'aws s3 cp "/workspace/$BIODOME_INTEGRATION_ARTIFACT_PATH" "s3://${BIODOME_ARTIFACT_BUCKET}/${BIODOME_ARTIFACT_PREFIX}/${BIODOME_DEPLOYMENT_ID}/${BIODOME_INTEGRATION_ARTIFACT_PATH}" --only-show-errors',
          'printf "%s\\n" "$BIODOME_INTEGRATION_LOG_MARKER"',
        ].join("\n");
        tracked.s3MayExist = true;
        const jobResult = await run(
          driver.runJob({
            ...statusInput,
            command: ["sh", "-c", jobScript],
            timeoutMs: 600_000,
            artifactPaths: [artifactPath],
          }),
        );

        // Discover and track both opaque job ARNs before asserting the result;
        // an ACTIVE definition below makes a failed runJob cleanup visible.
        const jobResources = await waitForFamilyResources(ecs, cluster, jobFamily, tracked);
        const jobTaskDefinitionArn = jobResources.taskDefinitionArns[0];
        const jobTaskArn = jobResources.taskArns[0];
        const describedJob = await ecs.send(
          new DescribeTasksCommand({ cluster, tasks: [jobTaskArn] }),
        );
        const jobTaskDefinition = await ecs.send(
          new DescribeTaskDefinitionCommand({ taskDefinition: jobTaskDefinitionArn }),
        );
        trackRequired(
          tracked.taskDefinitionArns,
          jobTaskDefinition.taskDefinition?.taskDefinitionArn,
          "the registered job task definition ARN",
        );

        expect(plan.deployment.task?.name).toBe(jobName);
        expect(jobResult.exitCode).toBe(0);
        expect(jobResult.timedOut).toBeFalsy();
        expect(describedJob.tasks?.[0]?.lastStatus).toBe("STOPPED");
        expect(describedJob.tasks?.[0]?.containers?.[0]?.exitCode).toBe(0);
        expect(["INACTIVE", "DELETE_IN_PROGRESS"]).toContain(
          jobTaskDefinition.taskDefinition?.status,
        );
        expect(jobTaskDefinition.taskDefinition?.containerDefinitions?.[0]?.image).toBe(imageRef);
        expect(jobTaskDefinition.taskDefinition?.containerDefinitions?.[0]?.secrets).toContainEqual(
          {
            name: "BIODOME_INTEGRATION_SENTINEL",
            valueFrom: sentinelSecretArn,
          },
        );
        expect(
          jobTaskDefinition.taskDefinition?.containerDefinitions?.[0]?.environment,
        ).not.toContainEqual(expect.objectContaining({ name: "BIODOME_INTEGRATION_SENTINEL" }));

        const artifacts = await run(
          driver.collectArtifacts({ ...statusInput, paths: [artifactPath] }),
        );
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]?.path).toBe(artifactPath);
        expect(readFileSync(artifacts[0].localPath, "utf-8")).toBe(expectedArtifact);

        // CloudWatch delivery is eventually consistent. Poll through the
        // driver's logs operation and require the named job's safe marker.
        await waitForLogMarker(driver, { ...statusInput, processName: jobName }, logMarker);

        await run(driver.stop(statusInput));
        await waitForStopped(ecs, cluster, startedTaskArn);

        const afterStop = await ecs.send(
          new DescribeTasksCommand({ cluster, tasks: [startedTaskArn] }),
        );
        expect(afterStop.tasks?.[0]?.lastStatus).toBe("STOPPED");

        const inactiveDeploymentDefinition = await ecs.send(
          new DescribeTaskDefinitionCommand({ taskDefinition: deploymentTaskDefinitionArn }),
        );
        trackRequired(
          tracked.taskDefinitionArns,
          inactiveDeploymentDefinition.taskDefinition?.taskDefinitionArn,
          "the stopped deployment task definition ARN",
        );
        expect(["INACTIVE", "DELETE_IN_PROGRESS"]).toContain(
          inactiveDeploymentDefinition.taskDefinition?.status,
        );

        const activeDefinitions = (
          await Promise.all(
            [...tracked.taskDefinitionFamilies].map((family) =>
              listTaskDefinitionArns(ecs, family, "ACTIVE"),
            ),
          )
        ).flat();
        for (const arn of activeDefinitions) tracked.taskDefinitionArns.add(arn);
        expect(activeDefinitions).toEqual([]);

        removeState(rootDir, target.name);
        expect(existsSync(statePath(rootDir, target.name))).toBe(false);
      } finally {
        await cleanupTrackedResources({
          ecs,
          ecr,
          cloudwatch,
          s3,
          cluster,
          repository,
          rootDir,
          targetName: target.name,
          deploymentId,
          tracked,
        });
      }
    },
  );
});
