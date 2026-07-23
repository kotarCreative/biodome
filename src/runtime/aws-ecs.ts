import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  DeregisterTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { NodeRuntime } from "../core/runtime-node.js";
import {
  generateDockerfile,
  generateSupervisordConf,
  generateDockerignore,
  generateHealthcheckScripts,
  generateRepoScripts,
  generateHarnessFiles,
  generatePiHarnessFiles,
  generateCodexHarnessFiles,
  generateClaudeHarnessFiles,
} from "../docker/generator.js";
import { generatePlanJson } from "../mcp/generator.js";
import { validateAwsEcsOptions, type AwsEcsOptions } from "./aws-ecs-schema.js";
import type {
  RuntimeDriver,
  RuntimeOperationInput,
  BuildResult,
  DeploymentState,
  CommandResult,
  Artifact,
  StatusResult,
} from "./driver.js";
import type { RuntimeTarget } from "../core/plan.js";
import type { Plan } from "../core/plan.js";
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";

export interface AwsClients {
  ecr: ECRClient;
  ecs: ECSClient;
  cloudwatch: CloudWatchLogsClient;
}

function createDefaultClients(region: string): AwsClients {
  return {
    ecr: new ECRClient({ region }),
    ecs: new ECSClient({ region }),
    cloudwatch: new CloudWatchLogsClient({ region }),
  };
}

function platformErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}

function resolveSecret(value: unknown): string | undefined {
  if (value && typeof value === "object" && "env" in (value as { env?: string })) {
    return process.env[(value as { env: string }).env];
  }
  if (typeof value === "string") return value;
  return undefined;
}

function wrapError(e: unknown): RuntimeError {
  if (e instanceof RuntimeError) return e;
  return new RuntimeError({ message: platformErrorMessage(e) });
}

function isAwsErrorNamed(error: unknown, name: string): boolean {
  return error !== null && typeof error === "object" && "name" in error && error.name === name;
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

export function createAwsEcsDriver(clients?: AwsClients): RuntimeDriver {
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

  function readStateFile(outputDir: string): { taskArn?: string; taskDefinitionArn?: string } {
    try {
      const parsed = JSON.parse(readFileSync(join(outputDir, "state.json"), "utf-8"));
      return parsed.resourceIds ?? {};
    } catch {
      return {};
    }
  }

  const driver: RuntimeDriver = {
    id: "aws-ecs",

    capabilities: capabilitiesOf(
      "lifecycle.build",
      "lifecycle.start",
      "lifecycle.stop",
      "status.read",
      "logs.stream",
    ),

    render(input: {
      rootDir: string;
      outputDir: string;
      plan: Plan;
      target: RuntimeTarget;
    }): Effect.Effect<string[], RuntimeError, never> {
      return Effect.try({
        try: () => {
          mkdirSync(input.outputDir, { recursive: true });
          const plan = input.plan;
          const files: string[] = [];

          const dockerfilePath = join(input.outputDir, "Dockerfile");
          writeFileSync(
            dockerfilePath,
            generateDockerfile(plan, {
              generatedFilesPath: `.biodome-build/targets/${input.target.name}`,
            }),
          );
          files.push(dockerfilePath);

          const supervisord = generateSupervisordConf(plan);
          if (supervisord) {
            const spPath = join(input.outputDir, "supervisord.conf");
            writeFileSync(spPath, supervisord);
            files.push(spPath);
          }

          const healthcheckDir = join(input.outputDir, "healthchecks");
          rmSync(healthcheckDir, { recursive: true, force: true });
          mkdirSync(healthcheckDir, { recursive: true });
          for (const [name, content] of Object.entries(generateHealthcheckScripts(plan))) {
            const path = join(healthcheckDir, name);
            writeFileSync(path, content);
            if (content.startsWith("#!/")) chmodSync(path, 0o755);
            files.push(path);
          }

          const repoDir = join(input.outputDir, "repos");
          rmSync(repoDir, { recursive: true, force: true });
          mkdirSync(repoDir, { recursive: true });
          for (const [name, content] of Object.entries(generateRepoScripts(plan))) {
            const path = join(repoDir, name);
            writeFileSync(path, content);
            if (content.startsWith("#!/")) chmodSync(path, 0o755);
            files.push(path);
          }

          for (const [name, content] of Object.entries(generateHarnessFiles(plan))) {
            writeBuildFile(join(input.outputDir, name), content);
            files.push(join(input.outputDir, name));
          }
          for (const [name, content] of Object.entries(generatePiHarnessFiles(plan))) {
            writeBuildFile(join(input.outputDir, name), content);
            files.push(join(input.outputDir, name));
          }
          for (const [name, content] of Object.entries(generateCodexHarnessFiles(plan))) {
            writeBuildFile(join(input.outputDir, name), content);
            files.push(join(input.outputDir, name));
          }
          for (const [name, content] of Object.entries(generateClaudeHarnessFiles(plan))) {
            writeBuildFile(join(input.outputDir, name), content);
            files.push(join(input.outputDir, name));
          }

          const dockerignorePath = join(input.rootDir, ".dockerignore");
          if (!existsSync(dockerignorePath)) {
            writeFileSync(dockerignorePath, generateDockerignore());
          }

          if (plan.build.mcpEnabled) {
            writeFileSync(join(input.outputDir, "plan.json"), generatePlanJson(plan));
            const __dirname = dirname(fileURLToPath(import.meta.url));
            const mcpServerSource = join(__dirname, "..", "mcp", "server.js");
            if (existsSync(mcpServerSource)) {
              copyFileSync(mcpServerSource, join(input.outputDir, "mcp-server.js"));
            }
          }

          return files;
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
        const exitCode = (yield* handle.exitCode) as number;
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
        Effect.catch((error) => Effect.fail(wrapError(error))),
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

        yield* runDockerCmd([
          "buildx",
          "build",
          "--platform",
          "linux/amd64",
          "-t",
          fullImage,
          "--push",
          "-f",
          join(input.outputDir, "Dockerfile"),
          input.rootDir,
        ]);

        return { imageRef: fullImage, digest: imageTag };
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(wrapError(error))),
      );
    },

    start(input: RuntimeOperationInput): Effect.Effect<DeploymentState, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const family = familyName(input.deploymentId);
        const lgGroup = logGroupName(input.plan.project, input.target.name);

        const containerEnv = buildContainerEnvironment(input.plan);
        const hasDaemonProcesses = input.plan.runtime.processes.some(
          (process) => process.mode === "daemon",
        );
        const defaultCommand = hasDaemonProcesses
          ? ["/usr/bin/supervisord", "-c", "/workspace/.biodome-build/supervisord.conf"]
          : undefined;
        const imageRef = imageUri(opts, input.deploymentId);

        yield* ensureLogGroup(c.cloudwatch, lgGroup);

        const registerResult = yield* Effect.tryPromise({
          try: () =>
            c.ecs.send(
              new RegisterTaskDefinitionCommand({
                family,
                executionRoleArn: resolveSecret(opts.executionRoleArn)!,
                taskRoleArn: opts.taskRoleArn ? resolveSecret(opts.taskRoleArn) : undefined,
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
            runResult.failures?.map((f) => `${f.arn}: ${f.reason}`).join("; ") || "unknown failure";
          return yield* new RuntimeError({ message: `ECS task failed to start: ${failures}` });
        }

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
        Effect.catch((error) => Effect.fail(wrapError(error))),
      );
    },

    stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const state = readStateFile(input.outputDir);
        const { taskArn, taskDefinitionArn } = state;

        if (!taskArn) return;

        yield* Effect.tryPromise({
          try: async () => {
            const describeTask = async () => {
              const description = await c.ecs.send(
                new DescribeTasksCommand({
                  cluster: opts.cluster,
                  tasks: [taskArn],
                }),
              );
              const task = description.tasks?.[0];
              if (task) return task;

              if (
                description.failures?.length &&
                description.failures.every((failure) => failure.reason === "MISSING")
              ) {
                return undefined;
              }

              const failures = description.failures
                ?.map((failure) => failure.reason ?? failure.detail ?? "unknown failure")
                .join("; ");
              throw new RuntimeError({
                message: `Failed to describe ECS task ${taskArn}: ${failures || "task was absent without a MISSING failure"}`,
              });
            };

            const task = await describeTask();
            if (!task || task.lastStatus === "STOPPED") return;

            await c.ecs.send(
              new StopTaskCommand({
                cluster: opts.cluster,
                task: taskArn,
                reason: "Stopped by biodome",
              }),
            );

            for (let i = 0; i < 30; i++) {
              const stoppedTask = await describeTask();
              if (!stoppedTask || stoppedTask.lastStatus === "STOPPED") return;
              if (i < 29) await new Promise((resolve) => setTimeout(resolve, 2000));
            }

            throw new RuntimeError({
              message: `Timed out waiting for ECS task ${taskArn} to stop`,
            });
          },
          catch: (error) =>
            error instanceof RuntimeError
              ? error
              : new RuntimeError({
                  message: `Failed to stop ECS task ${taskArn}: ${platformErrorMessage(error)}`,
                }),
        });

        if (taskDefinitionArn) {
          yield* Effect.tryPromise({
            try: () =>
              c.ecs.send(
                new DeregisterTaskDefinitionCommand({
                  taskDefinition: taskDefinitionArn,
                }),
              ),
            catch: (error) =>
              new RuntimeError({
                message: `Failed to deregister ECS task definition ${taskDefinitionArn}: ${platformErrorMessage(error)}`,
              }),
          });
        }
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(wrapError(error))),
      );
    },

    exec(
      input: RuntimeOperationInput & { command: string[] },
    ): Effect.Effect<CommandResult, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const family = familyName(input.deploymentId);
        const lgGroup = logGroupName(input.plan.project, input.target.name);
        const imageRef = imageUri(opts, input.deploymentId);
        const startTime = Date.now();

        const containerEnv = buildContainerEnvironment(input.plan);

        yield* ensureLogGroup(c.cloudwatch, lgGroup);

        const registerResult = yield* Effect.tryPromise({
          try: () =>
            c.ecs.send(
              new RegisterTaskDefinitionCommand({
                family: `${family}-exec`,
                executionRoleArn: resolveSecret(opts.executionRoleArn)!,
                taskRoleArn: opts.taskRoleArn ? resolveSecret(opts.taskRoleArn) : undefined,
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

        let exitCode = 0;
        let lastStatus = "PENDING";
        const pollStart = Date.now();
        const pollTimeout = 3600000;

        while (Date.now() - pollStart < pollTimeout) {
          const desc = yield* Effect.tryPromise({
            try: () =>
              c.ecs.send(
                new DescribeTasksCommand({
                  cluster: opts.cluster,
                  tasks: [taskArn],
                }),
              ),
            catch: () => ({ tasks: [] as any[] }),
          });

          const task = desc.tasks?.[0];
          if (!task) break;

          lastStatus = task.lastStatus || "UNKNOWN";
          if (lastStatus === "STOPPED") {
            exitCode = task.containers?.[0]?.exitCode ?? 0;
            break;
          }
          yield* Effect.sleep("2 seconds");
        }

        if (lastStatus !== "STOPPED") {
          yield* Effect.tryPromise(() =>
            c.ecs
              .send(
                new StopTaskCommand({
                  cluster: opts.cluster,
                  task: taskArn,
                  reason: "Timed out waiting for exec task",
                }),
              )
              .catch(() => {}),
          );
          return yield* new RuntimeError({ message: "Exec task timed out" });
        }

        yield* Effect.tryPromise(() =>
          c.ecs
            .send(
              new DeregisterTaskDefinitionCommand({
                taskDefinition: taskDefArn,
              }),
            )
            .catch(() => {}),
        );

        return {
          exitCode,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - startTime,
        };
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(wrapError(error))),
      );
    },

    collectArtifacts(
      _input: RuntimeOperationInput & { paths: string[] },
    ): Effect.Effect<Artifact[], RuntimeError, EventStore> {
      return Effect.fail(
        new RuntimeError({
          message:
            "The aws-ecs driver does not support artifact collection yet. Use a Docker Compose target for task execution with artifacts.",
        }),
      );
    },

    status(input: RuntimeOperationInput): Effect.Effect<StatusResult, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = validateAwsEcsOptions(input.target.options);
        const c = getClients(opts);
        const state = readStateFile(input.outputDir);
        const taskArn = state.taskArn;

        if (!taskArn) {
          return { state: "unknown" as const, message: "No task ARN in state" };
        }

        const desc = yield* Effect.tryPromise({
          try: () =>
            c.ecs.send(
              new DescribeTasksCommand({
                cluster: opts.cluster,
                tasks: [taskArn],
              }),
            ),
          catch: () => ({ tasks: [] as any[] }),
        });

        const task = desc.tasks?.[0];
        if (!task) return { state: "stopped" as const, message: "Task not found" };

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
        Effect.catch((error) => Effect.fail(wrapError(error))),
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
          catch: () => ({ logStreams: [] as any[] }),
        });

        const logStreams = streamsResult.logStreams || [];
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
                  logStreamName: stream.logStreamName!,
                  limit: 100,
                }),
              ),
            catch: () => ({ events: [] as any[] }),
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
        Effect.catch((error) => Effect.fail(wrapError(error))),
      );
    },

    restart(
      input: RuntimeOperationInput & { processName: string },
    ): Effect.Effect<void, RuntimeError, EventStore> {
      return driver.stop(input).pipe(
        Effect.andThen(() => driver.start(input)),
        Effect.map(() => undefined),
      );
    },
  };

  return driver;
}

export const awsEcsDriver = createAwsEcsDriver();

// --- Helpers ---

function writeBuildFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  if (content.startsWith("#!/")) {
    chmodSync(filePath, 0o755);
  }
}

function buildContainerEnvironment(plan: Plan): Array<{ name: string; value: string }> {
  const env: Array<{ name: string; value: string }> = [];
  if (plan.runtime?.environment) {
    for (const [key, value] of Object.entries(plan.runtime.environment)) {
      env.push({ name: key, value: value as string });
    }
  }
  return env;
}

function runDockerCmd(args: string[]): Effect.Effect<void, RuntimeError, never> {
  return Effect.gen(function* () {
    const handle = yield* ChildProcess.make("docker", args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = (yield* handle.exitCode) as number;
    if (exitCode !== 0) {
      return yield* new RuntimeError({
        message: `exited with code ${exitCode}`,
        command: `docker ${args.join(" ")}`,
      });
    }
  }).pipe(
    Effect.provide(NodeRuntime),
    Effect.scoped,
    Effect.catch((error) => Effect.fail(wrapError(error))),
  );
}
