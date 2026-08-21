import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Result } from "effect";
import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  DeregisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import type { Task } from "@aws-sdk/client-ecs";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { NodeRuntime } from "../core/runtime-node.js";
import { validateAwsEcsOptions, type AwsEcsOptions } from "./aws-ecs-schema.js";
import type {
  AvailableDriver,
  ArtifactDriver,
  BuildableDriver,
  JobDriver,
  LogDriver,
  RenderableDriver,
  RuntimeDriver,
  RuntimeOperationInput,
  StartInput,
  JobInput,
  BuildResult,
  DeploymentState,
  CommandResult,
  Artifact,
  StatusDriver,
  StatusResult,
  StartableDriver,
  StoppableDriver,
} from "./driver.js";
import type { RuntimeTarget } from "../core/plan.js";
import type { Plan } from "../core/plan.js";
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";
import { runtimeLayout } from "./layout.js";
import { renderCommonArtifacts, writeArtifacts } from "./artifacts.js";
import { TIMEOUT_EXIT_CODE, platformErrorMessage, runProcess, toRuntimeError } from "./proc.js";

export interface AwsClients {
  ecr: ECRClient;
  ecs: ECSClient;
  cloudwatch: CloudWatchLogsClient;
  s3?: S3Client;
}

/** Consecutive DescribeTasks failures tolerated while polling a job task. */
const MAX_DESCRIBE_FAILURES = 5;
const JOB_POLL_INTERVAL = "2 seconds";

function createDefaultClients(region: string): AwsClients {
  return {
    ecr: new ECRClient({ region }),
    ecs: new ECSClient({ region }),
    cloudwatch: new CloudWatchLogsClient({ region }),
    s3: new S3Client({ region }),
  };
}

function resolveSecret(value: unknown, description: string): string {
  const envName =
    value && typeof value === "object" && "env" in value && typeof value.env === "string"
      ? value.env
      : undefined;
  const resolved =
    envName !== undefined ? process.env[envName] : typeof value === "string" ? value : undefined;
  if (resolved === undefined || resolved === "") {
    throw new RuntimeError({
      message: `Failed to resolve ${description}${envName ? ` from environment variable "${envName}"` : ""}. Set it in the host environment before deploying to ECS.`,
    });
  }
  return resolved;
}

function isAwsErrorNamed(error: unknown, name: string): boolean {
  return error !== null && typeof error === "object" && "name" in error && error.name === name;
}

/**
 * Describe an ECS task, distinguishing query failures from a genuinely absent
 * task: API errors and non-MISSING describe failures raise typed errors, while
 * a MISSING task resolves to `undefined` for callers to interpret.
 */
function describeEcsTask(
  ecs: ECSClient,
  cluster: string,
  taskArn: string,
): Effect.Effect<Task | undefined, RuntimeError> {
  return Effect.tryPromise({
    try: () => ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] })),
    catch: (error) =>
      new RuntimeError({
        message: `Failed to query ECS task ${taskArn}: ${platformErrorMessage(error)}`,
      }),
  }).pipe(
    Effect.flatMap((response) => {
      const task = response.tasks?.[0];
      if (task) return Effect.succeed(task);
      const failures = response.failures ?? [];
      if (failures.length > 0 && failures.every((failure) => failure.reason === "MISSING")) {
        return Effect.succeed(undefined);
      }
      const detail = failures
        .map((failure) => failure.reason ?? failure.detail ?? "unknown failure")
        .join("; ");
      return Effect.fail(
        new RuntimeError({
          message: `Failed to query ECS task ${taskArn}: ${detail || "task was absent without a MISSING failure"}`,
        }),
      );
    }),
  );
}

/** Best-effort ECS cleanup that reports tolerated failures without failing. */
function bestEffortCleanup(
  operation: Effect.Effect<void, RuntimeError>,
  description: string,
): Effect.Effect<void, never> {
  return operation.pipe(
    Effect.catch((error) =>
      Effect.sync(() => console.warn(`[biodome] ${description}: ${error.message}`)),
    ),
  );
}

function deregisterTaskDefinition(
  ecs: ECSClient,
  taskDefinitionArn: string,
): Effect.Effect<void, RuntimeError> {
  return Effect.tryPromise({
    try: async () => {
      await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }));
    },
    catch: (error) =>
      new RuntimeError({
        message: `Failed to deregister ECS task definition ${taskDefinitionArn}: ${platformErrorMessage(error)}`,
      }),
  }).pipe(Effect.asVoid);
}

function stopEcsTask(ecs: ECSClient, cluster: string, taskArn: string, reason: string) {
  return Effect.tryPromise({
    try: async () => {
      await ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason }));
    },
    catch: (error) =>
      new RuntimeError({
        message: `Failed to stop ECS task ${taskArn}: ${platformErrorMessage(error)}`,
      }),
  }).pipe(Effect.asVoid);
}

function passthroughEnvKeys(plan: Plan): string[] {
  return plan.runtime.envVars
    .filter((envVar) => envVar.from !== undefined)
    .map((envVar) => envVar.key);
}

function passthroughEnvError(keys: string[]): RuntimeError {
  return new RuntimeError({
    message: `The aws-ecs target does not support host-env passthrough yet, so these environment variables cannot be resolved from the host: ${keys.join(", ")}. Provide literal values for them instead.`,
  });
}

/** Read the immutable OCI image digest emitted by `docker buildx build --push`. */
export function buildxImageDigest(metadata: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata) as unknown;
  } catch {
    throw new RuntimeError({ message: "Docker Buildx returned invalid image metadata" });
  }
  const digest =
    parsed && typeof parsed === "object" && "containerimage.digest" in parsed
      ? parsed["containerimage.digest"]
      : undefined;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new RuntimeError({ message: "Docker Buildx did not return an immutable image digest" });
  }
  return digest;
}

function ensureLogGroup(
  cloudwatch: CloudWatchLogsClient,
  logGroupName: string,
): Effect.Effect<void, RuntimeError> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await cloudwatch.send(new CreateLogGroupCommand({ logGroupName }));
      } catch (error) {
        if (isAwsErrorNamed(error, "ResourceAlreadyExistsException")) return;
        throw error;
      }
    },
    catch: (error) =>
      new RuntimeError({
        message: `Failed to create CloudWatch log group ${logGroupName}: ${platformErrorMessage(error)}`,
      }),
  }).pipe(Effect.asVoid);
}

export function createAwsEcsDriver(
  clients?: AwsClients,
): RuntimeDriver &
  AvailableDriver &
  RenderableDriver &
  BuildableDriver &
  StartableDriver &
  StoppableDriver &
  JobDriver &
  ArtifactDriver &
  StatusDriver &
  LogDriver {
  function getClients(options: AwsEcsOptions): AwsClients {
    return clients ?? createDefaultClients(options.region);
  }

  function imageUri(options: AwsEcsOptions, tag: string): string {
    return `${options.repository}:${tag}`;
  }

  function familyName(deploymentId: string): string {
    return `biodome-${deploymentId}`;
  }

  function logGroupName(project: string, targetName: string): string {
    return `/biodome/${project}/${targetName}`;
  }

  function requireState(
    input: RuntimeOperationInput,
    operation: string,
  ): { taskArn?: string; taskDefinitionArn?: string } {
    const state = input.state;
    if (!state) {
      throw new RuntimeError({
        message: `The aws-ecs driver cannot ${operation} without validated deployment state`,
      });
    }
    return state.resourceIds;
  }

  const driver: RuntimeDriver &
    AvailableDriver &
    RenderableDriver &
    BuildableDriver &
    StartableDriver &
    StoppableDriver &
    JobDriver &
    ArtifactDriver &
    StatusDriver &
    LogDriver = {
    id: "aws-ecs",

    capabilities: capabilitiesOf(
      "lifecycle.build",
      "lifecycle.start",
      "lifecycle.stop",
      "status.read",
      "logs.stream",
      "job.run",
      "artifact.collect",
    ),

    render(input: {
      rootDir: string;
      outputDir: string;
      plan: Plan;
      target: RuntimeTarget;
    }): Effect.Effect<string[], RuntimeError, never> {
      const passthroughKeys = passthroughEnvKeys(input.plan);
      if (passthroughKeys.length > 0) {
        return Effect.fail(passthroughEnvError(passthroughKeys));
      }
      return Effect.try({
        try: () => {
          const layout = runtimeLayout(input.rootDir, input.target.name);
          return Array.from(
            Effect.runSync(
              writeArtifacts(input.rootDir, renderCommonArtifacts(input.plan, layout)),
            ),
          );
        },
        catch: (error) =>
          new RuntimeError({
            message: `Failed to render ECS target: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });
    },

    ensureAvailable(target: RuntimeTarget): Effect.Effect<void, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const handle = yield* ChildProcess.make("docker", ["version"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        const exitCode = yield* handle.exitCode;
        if (exitCode !== 0) {
          return yield* new RuntimeError({
            message: "Docker is not available or the daemon is not running.",
          });
        }

        yield* Effect.tryPromise({
          try: async () => {
            const opts = validateAwsEcsOptions(target.options);
            const c = getClients(opts);
            await c.ecr.config.region();
          },
          catch: () =>
            new RuntimeError({
              message:
                "AWS credentials are not configured or ECR is not accessible. Ensure AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are set.",
            }),
        });
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    build(input: RuntimeOperationInput): Effect.Effect<BuildResult, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const imageTag = input.deploymentId;
        const fullImage = imageUri(opts, imageTag);

        const authResponse = yield* Effect.tryPromise({
          try: () => c.ecr.send(new GetAuthorizationTokenCommand({})),
          catch: (error) =>
            new RuntimeError({
              message: `Failed to get ECR authorization: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        const authData = authResponse.authorizationData?.[0];
        if (!authData?.authorizationToken) {
          return yield* new RuntimeError({ message: "No ECR authorization token returned" });
        }
        const proxyEndpoint = authData.proxyEndpoint
          ? new URL(authData.proxyEndpoint).host
          : opts.repository.split("/")[0];
        const token = Buffer.from(authData.authorizationToken, "base64").toString("utf-8");
        const [user, pass] = token.split(":");

        yield* Effect.try({
          try: () => {
            execFileSync("docker", ["login", "-u", user, "--password-stdin", proxyEndpoint], {
              input: pass,
              stdio: ["pipe", "ignore", "ignore"],
            });
          },
          catch: (error) =>
            new RuntimeError({
              message: `Docker login failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const metadataDir = yield* Effect.try({
          try: () => mkdtempSync(join(tmpdir(), "biodome-buildx-")),
          catch: (error) =>
            new RuntimeError({
              message: `Failed to create Docker Buildx metadata directory: ${platformErrorMessage(error)}`,
            }),
        });
        const metadataPath = join(metadataDir, "metadata.json");
        try {
          yield* runProcess({
            command: "docker",
            args: [
              "buildx",
              "build",
              "--platform",
              "linux/amd64",
              "-t",
              fullImage,
              "--push",
              "--metadata-file",
              metadataPath,
              "-f",
              join(input.outputDir, "Dockerfile"),
              input.rootDir,
            ],
          });
          const digest = yield* Effect.try({
            try: () => buildxImageDigest(readFileSync(metadataPath, "utf-8")),
            catch: toRuntimeError,
          });
          return { imageRef: `${opts.repository}@${digest}`, digest };
        } finally {
          rmSync(metadataDir, { recursive: true, force: true });
        }
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    start(input: StartInput): Effect.Effect<DeploymentState, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const family = familyName(input.deploymentId);
        const lgGroup = logGroupName(input.plan.project, input.target.name);

        const passthroughKeys = passthroughEnvKeys(input.plan);
        if (passthroughKeys.length > 0) {
          return yield* passthroughEnvError(passthroughKeys);
        }

        const containerEnv = buildContainerEnvironment(input.plan);
        const hasDaemonProcesses = input.plan.runtime.processes.some(
          (process) => process.mode === "daemon",
        );
        const layout = runtimeLayout(input.rootDir, input.target.name).container;
        const defaultCommand = hasDaemonProcesses ? ["sh", layout.startupScript] : undefined;
        const imageRef = input.buildManifest.imageRef ?? imageUri(opts, input.deploymentId);

        yield* ensureLogGroup(c.cloudwatch, lgGroup);

        const registerResult = yield* Effect.tryPromise({
          try: () =>
            c.ecs.send(
              new RegisterTaskDefinitionCommand({
                family,
                executionRoleArn: resolveSecret(
                  opts.executionRoleArn,
                  "the ECS execution role ARN",
                ),
                taskRoleArn: opts.taskRoleArn
                  ? resolveSecret(opts.taskRoleArn, "the ECS task role ARN")
                  : undefined,
                networkMode: "awsvpc",
                requiresCompatibilities: ["FARGATE"],
                cpu: String(opts.cpu ?? 1024),
                memory: String(opts.memoryMiB ?? 2048),
                containerDefinitions: [
                  {
                    name: "dev",
                    image: imageRef,
                    essential: true,
                    command: defaultCommand,
                    environment: containerEnv.map((e) => ({ name: e.name, value: e.value })),
                    logConfiguration: {
                      logDriver: "awslogs",
                      options: {
                        "awslogs-group": lgGroup,
                        "awslogs-region": opts.region,
                        "awslogs-stream-prefix": input.deploymentId,
                      },
                    },
                    readonlyRootFilesystem: false,
                    linuxParameters: {
                      initProcessEnabled: true,
                    },
                  },
                ],
              }),
            ),
          catch: (error) =>
            new RuntimeError({
              message: `Failed to register ECS task definition: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const taskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
        if (!taskDefArn) {
          return yield* new RuntimeError({ message: "No task definition ARN returned" });
        }

        // A service task definition should persist once its task launches,
        // but a failed or interrupted launch would otherwise leak it.
        const launchTask = Effect.gen(function* () {
          const runResult = yield* Effect.tryPromise({
            try: () =>
              c.ecs.send(
                new RunTaskCommand({
                  cluster: opts.cluster,
                  taskDefinition: taskDefArn,
                  launchType: "FARGATE",
                  networkConfiguration: {
                    awsvpcConfiguration: {
                      subnets: opts.subnets,
                      securityGroups: opts.securityGroups,
                      assignPublicIp: opts.assignPublicIp ? "ENABLED" : "DISABLED",
                    },
                  },
                }),
              ),
            catch: (error) =>
              new RuntimeError({
                message: `Failed to run ECS task: ${error instanceof Error ? error.message : String(error)}`,
              }),
          });

          const taskArn = runResult.tasks?.[0]?.taskArn;
          if (!taskArn) {
            const failures =
              runResult.failures?.map((f) => `${f.arn}: ${f.reason}`).join("; ") ||
              "unknown failure";
            return yield* new RuntimeError({ message: `ECS task failed to start: ${failures}` });
          }
          return taskArn;
        }).pipe(
          Effect.onError(() =>
            bestEffortCleanup(
              deregisterTaskDefinition(c.ecs, taskDefArn),
              `Deregistered leaked task definition ${taskDefArn} after failed start`,
            ),
          ),
          Effect.onInterrupt(() =>
            bestEffortCleanup(
              deregisterTaskDefinition(c.ecs, taskDefArn),
              `Deregistered task definition ${taskDefArn} after interrupted start`,
            ),
          ),
        );

        const taskArn = yield* launchTask;

        return {
          driver: "aws-ecs",
          deploymentId: input.deploymentId,
          resourceIds: {
            taskDefinitionArn: taskDefArn,
            taskArn,
            logGroup: lgGroup,
          },
          createdAt: new Date().toISOString(),
        };
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const { taskArn, taskDefinitionArn } = requireState(input, "stop");

        if (!taskArn) return;

        const stopFlow = Effect.gen(function* () {
          const task = yield* describeEcsTask(c.ecs, opts.cluster, taskArn);
          if (!task || task.lastStatus === "STOPPED") return;

          yield* stopEcsTask(c.ecs, opts.cluster, taskArn, "Stopped by biodome");

          for (let i = 0; i < 30; i++) {
            const stoppedTask = yield* describeEcsTask(c.ecs, opts.cluster, taskArn);
            if (!stoppedTask || stoppedTask.lastStatus === "STOPPED") return;
            if (i < 29) yield* Effect.sleep("2 seconds");
          }

          return yield* new RuntimeError({
            message: `Timed out waiting for ECS task ${taskArn} to stop`,
          });
        });

        yield* stopFlow.pipe(
          Effect.catch((error) =>
            Effect.fail(
              error instanceof RuntimeError
                ? error
                : new RuntimeError({
                    message: `Failed to stop ECS task ${taskArn}: ${platformErrorMessage(error)}`,
                  }),
            ),
          ),
        );

        if (taskDefinitionArn) {
          yield* deregisterTaskDefinition(c.ecs, taskDefinitionArn);
        }
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    runJob(input: JobInput): Effect.Effect<CommandResult, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const family = familyName(input.deploymentId);
        const lgGroup = logGroupName(input.plan.project, input.target.name);
        const imageRef = input.buildManifest.imageRef ?? imageUri(opts, input.deploymentId);
        const startTime = Date.now();

        // Tracked so the all-exits finalizer below can release ECS resources.
        const refs: {
          taskArn?: string;
          taskDefArn?: string;
          lastStatus: string;
        } = { lastStatus: "PENDING" };

        const passthroughKeys = passthroughEnvKeys(input.plan);
        if (passthroughKeys.length > 0) {
          return yield* passthroughEnvError(passthroughKeys);
        }

        const containerEnv = buildContainerEnvironment(input.plan);
        let bucket: string | undefined;
        let taskRoleArn: string | undefined;
        if (input.artifactPaths && input.artifactPaths.length > 0) {
          if (!opts.artifactBucket) {
            return yield* new RuntimeError({
              message:
                "The aws-ecs target does not have artifactBucket configured. Configure artifactBucket to run tasks with artifacts.",
            });
          }
          if (!opts.taskRoleArn) {
            return yield* new RuntimeError({
              message:
                "The aws-ecs target needs taskRoleArn configured to upload task artifacts to S3.",
            });
          }
          bucket = resolveSecret(opts.artifactBucket, "the S3 artifact bucket");
          taskRoleArn = resolveSecret(opts.taskRoleArn, "the ECS task role ARN");
          containerEnv.push({ name: "BIODOME_ARTIFACT_BUCKET", value: bucket });
          containerEnv.push({
            name: "BIODOME_ARTIFACT_PREFIX",
            value: opts.artifactPrefix ? opts.artifactPrefix.replace(/\/+$/, "") : "artifacts",
          });
          containerEnv.push({ name: "BIODOME_DEPLOYMENT_ID", value: input.deploymentId });
          containerEnv.push({
            name: "BIODOME_ARTIFACT_PATHS",
            value: JSON.stringify(input.artifactPaths),
          });
        }

        yield* ensureLogGroup(c.cloudwatch, lgGroup);

        const job = Effect.gen(function* () {
          const registerResult = yield* Effect.tryPromise({
            try: () =>
              c.ecs.send(
                new RegisterTaskDefinitionCommand({
                  family: `${family}-exec`,
                  executionRoleArn: resolveSecret(
                    opts.executionRoleArn,
                    "the ECS execution role ARN",
                  ),
                  taskRoleArn,
                  networkMode: "awsvpc",
                  requiresCompatibilities: ["FARGATE"],
                  cpu: String(opts.cpu ?? 1024),
                  memory: String(opts.memoryMiB ?? 2048),
                  containerDefinitions: [
                    {
                      name: "dev",
                      image: imageRef,
                      essential: true,
                      command: input.command,
                      environment: containerEnv.map((e) => ({ name: e.name, value: e.value })),
                      logConfiguration: {
                        logDriver: "awslogs",
                        options: {
                          "awslogs-group": lgGroup,
                          "awslogs-region": opts.region,
                          "awslogs-stream-prefix": `${input.deploymentId}-exec`,
                        },
                      },
                      readonlyRootFilesystem: false,
                      linuxParameters: {
                        initProcessEnabled: true,
                      },
                    },
                  ],
                }),
              ),
            catch: (error) =>
              new RuntimeError({
                message: `Failed to register exec task definition: ${error instanceof Error ? error.message : String(error)}`,
              }),
          });

          const taskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
          if (!taskDefArn) {
            return yield* new RuntimeError({ message: "No task definition ARN returned for exec" });
          }
          refs.taskDefArn = taskDefArn;

          const runResult = yield* Effect.tryPromise({
            try: () =>
              c.ecs.send(
                new RunTaskCommand({
                  cluster: opts.cluster,
                  taskDefinition: taskDefArn,
                  launchType: "FARGATE",
                  networkConfiguration: {
                    awsvpcConfiguration: {
                      subnets: opts.subnets,
                      securityGroups: opts.securityGroups,
                      assignPublicIp: opts.assignPublicIp ? "ENABLED" : "DISABLED",
                    },
                  },
                }),
              ),
            catch: (error) =>
              new RuntimeError({
                message: `Failed to run exec ECS task: ${error instanceof Error ? error.message : String(error)}`,
              }),
          });

          const taskArn = runResult.tasks?.[0]?.taskArn;
          if (!taskArn) {
            return yield* new RuntimeError({ message: "Exec task failed to start" });
          }
          refs.taskArn = taskArn;

          let exitCode = 0;
          const pollStart = Date.now();
          const pollTimeout = input.timeoutMs ?? 3600000;
          let describeFailures = 0;

          while (Date.now() - pollStart < pollTimeout) {
            // Transient DescribeTasks errors are retried on the polling cadence
            // rather than mistaken for a finished (or vanished) task.
            const described = yield* Effect.result(describeEcsTask(c.ecs, opts.cluster, taskArn));
            if (Result.isFailure(described)) {
              describeFailures += 1;
              if (describeFailures >= MAX_DESCRIBE_FAILURES) {
                return yield* new RuntimeError({
                  message: `Failed to poll ECS exec task ${taskArn} after ${describeFailures} consecutive DescribeTasks errors: ${described.failure.message}`,
                });
              }
              yield* Effect.sleep(JOB_POLL_INTERVAL);
              continue;
            }
            describeFailures = 0;

            const task = described.success;
            if (!task) {
              return yield* new RuntimeError({
                message: `ECS exec task ${taskArn} disappeared from the cluster before reaching a terminal state`,
              });
            }

            refs.lastStatus = task.lastStatus || "UNKNOWN";
            if (refs.lastStatus === "STOPPED") {
              exitCode = task.containers?.[0]?.exitCode ?? 0;
              break;
            }
            yield* Effect.sleep(JOB_POLL_INTERVAL);
          }

          if (refs.lastStatus !== "STOPPED") {
            return {
              exitCode: TIMEOUT_EXIT_CODE,
              stdout: "",
              stderr: "",
              durationMs: Date.now() - startTime,
              timedOut: true,
            };
          }

          return {
            exitCode,
            stdout: "",
            stderr: "",
            durationMs: Date.now() - startTime,
          };
        });

        return yield* Effect.ensuring(
          job,
          Effect.gen(function* () {
            if (refs.taskArn && refs.lastStatus !== "STOPPED") {
              yield* bestEffortCleanup(
                stopEcsTask(c.ecs, opts.cluster, refs.taskArn, "Timed out waiting for exec task"),
                `Failed to stop ECS exec task ${refs.taskArn} during cleanup`,
              );
            }
            if (refs.taskDefArn) {
              yield* bestEffortCleanup(
                deregisterTaskDefinition(c.ecs, refs.taskDefArn),
                `Failed to deregister ECS exec task definition ${refs.taskDefArn} during cleanup`,
              );
            }
          }),
        );
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    collectArtifacts(
      input: RuntimeOperationInput & { paths: string[] },
    ): Effect.Effect<Artifact[], RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        if (!opts.artifactBucket) {
          return yield* new RuntimeError({
            message:
              "The aws-ecs target does not have artifactBucket configured. Configure artifactBucket in target options to collect task artifacts.",
          });
        }
        const bucket = resolveSecret(opts.artifactBucket, "the S3 artifact bucket");
        if (!bucket) {
          return yield* new RuntimeError({
            message: "Failed to resolve artifactBucket value from environment",
          });
        }
        const prefix = opts.artifactPrefix ? opts.artifactPrefix.replace(/\/+$/, "") : "artifacts";
        const c = getClients(opts);
        const s3 = c.s3 ?? new S3Client({ region: opts.region });

        const artifactsDir = join(input.outputDir, "artifacts");
        mkdirSync(artifactsDir, { recursive: true });

        const artifacts: Artifact[] = [];
        for (const requestedPath of input.paths) {
          const s3Key = `${prefix}/${input.deploymentId}/${requestedPath}`;
          const localPath = join(artifactsDir, requestedPath);
          mkdirSync(dirname(localPath), { recursive: true });

          const response = yield* Effect.tryPromise({
            try: async () => {
              const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
              if (!res.Body) throw new Error(`Empty body for S3 object ${s3Key}`);
              const byteArray = await res.Body.transformToByteArray();
              writeFileSync(localPath, byteArray);
              return { sizeBytes: byteArray.length };
            },
            catch: (error) =>
              new RuntimeError({
                message: `Failed to download artifact "${requestedPath}" from s3://${bucket}/${s3Key}: ${platformErrorMessage(error)}`,
              }),
          });

          artifacts.push({
            path: requestedPath,
            sizeBytes: response.sizeBytes,
            localPath,
          });
        }

        return artifacts;
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    status(input: RuntimeOperationInput): Effect.Effect<StatusResult, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const { taskArn } = requireState(input, "query status");

        if (!taskArn) {
          return { state: "unknown" as const, message: "No task ARN in state" };
        }

        const task = yield* describeEcsTask(c.ecs, opts.cluster, taskArn);

        if (!task) {
          return { state: "stopped" as const, message: "ECS task not found (missing)" };
        }

        const lastStatus = task.lastStatus || "UNKNOWN";
        switch (lastStatus) {
          case "RUNNING":
            return { state: "running" as const, message: "ECS task is running" };
          case "PENDING":
          case "PROVISIONING":
          case "ACTIVATING":
            return {
              state: "pending" as const,
              message: `ECS task is ${lastStatus.toLowerCase()}`,
            };
          case "STOPPED":
          case "DEPROVISIONING": {
            const stopCode = task.stopCode ? ` (${task.stopCode})` : "";
            return { state: "stopped" as const, message: `ECS task stopped${stopCode}` };
          }
          default:
            return { state: "unknown" as const, message: `ECS task status: ${lastStatus}` };
        }
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    logs(
      input: RuntimeOperationInput & { processName?: string },
    ): Effect.Effect<void, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const lgGroup = logGroupName(input.plan.project, input.target.name);
        const streamPrefix = input.processName
          ? `${input.deploymentId}-exec/${input.processName}`
          : input.deploymentId;

        const streamsResult = yield* Effect.tryPromise({
          try: () =>
            c.cloudwatch.send(
              new DescribeLogStreamsCommand({
                logGroupName: lgGroup,
                logStreamNamePrefix: streamPrefix,
                orderBy: "LastEventTime",
                descending: true,
                limit: 10,
              }),
            ),
          catch: (error) =>
            new RuntimeError({
              message: `Failed to list CloudWatch log streams in ${lgGroup} (check CloudWatch Logs access): ${platformErrorMessage(error)}`,
            }),
        });

        const logStreams = (streamsResult.logStreams || []).filter(
          (stream): stream is typeof stream & { logStreamName: string } =>
            typeof stream.logStreamName === "string",
        );
        if (logStreams.length === 0) {
          console.log(`No log streams found matching ${streamPrefix}`);
          return;
        }

        for (const stream of logStreams.slice(0, 3)) {
          const eventsResult = yield* Effect.tryPromise({
            try: () =>
              c.cloudwatch.send(
                new GetLogEventsCommand({
                  logGroupName: lgGroup,
                  logStreamName: stream.logStreamName,
                  limit: 100,
                }),
              ),
            catch: (error) =>
              new RuntimeError({
                message: `Failed to read CloudWatch log events from stream ${stream.logStreamName} (check CloudWatch Logs access): ${platformErrorMessage(error)}`,
              }),
          });

          const events = eventsResult.events || [];
          for (const event of events) {
            const timestamp = event.timestamp ? new Date(event.timestamp).toISOString() : "";
            console.log(`[${timestamp}] ${event.message}`);
          }
        }
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },
  };

  return driver;
}

export const awsEcsDriver = createAwsEcsDriver();

// --- Helpers ---

function buildContainerEnvironment(plan: Plan): Array<{ name: string; value: string }> {
  const env: Array<{ name: string; value: string }> = [];
  if (plan.runtime?.environment) {
    for (const [key, value] of Object.entries(plan.runtime.environment)) {
      env.push({ name: key, value });
    }
  }
  return env;
}
