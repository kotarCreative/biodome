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
import type { Task, ContainerDefinition } from "@aws-sdk/client-ecs";
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
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
import { identitiesOf } from "../core/plan.js";
import { RuntimeError } from "../core/errors.js";
import { isSecretArnReference } from "../core/secrets.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";
import { runtimeLayout } from "./layout.js";
import { renderCommonArtifacts, writeArtifacts } from "./artifacts.js";
import { TIMEOUT_EXIT_CODE, platformErrorMessage, runProcess, toRuntimeError } from "./proc.js";
import { assertRelativeArtifactPath } from "./driver-kit.js";
import { writeState, removeState } from "./state.js";

export interface AwsClients {
  ecr: ECRClient;
  ecs: ECSClient;
  cloudwatch: CloudWatchLogsClient;
  s3?: S3Client;
}

/** Bounded, injectable polling policy for waiting until a started task is usable. */
export interface EcsPollingPolicy {
  /** Delay between DescribeTasks probes. */
  readonly intervalMs: number;
  /** Maximum wall-clock time spent waiting for the task to become usable. */
  readonly timeoutMs: number;
}

const DEFAULT_START_POLLING: EcsPollingPolicy = {
  intervalMs: 2_000,
  // Fargate pulls routinely take minutes; ten minutes bounds pathological hangs.
  timeoutMs: 600_000,
};

/** Consecutive DescribeTasks failures tolerated while polling a job task. */
const MAX_DESCRIBE_FAILURES = 5;
const JOB_POLL_INTERVAL = "2 seconds";

/** Hard cap on bytes downloaded per collected artifact object. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

const ARN_PREFIXES = ["arn:aws:secretsmanager:", "arn:aws:ssm:"];

function createDefaultClients(region: string): AwsClients {
  return {
    ecr: new ECRClient({ region }),
    ecs: new ECSClient({ region }),
    cloudwatch: new CloudWatchLogsClient({ region }),
    s3: new S3Client({ region }),
  };
}

// --- AWS error classification (Plan 05 step 9) ---

type AwsFailureKind = "authorization" | "throttling" | "missing-resource" | "transport" | "unknown";

const AUTHORIZATION_ERRORS = new Set([
  "AccessDeniedException",
  "AccessDenied",
  "UnauthorizedOperation",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "ExpiredTokenException",
  "SignatureDoesNotMatch",
  "NoCredentialsError",
  "CredentialsProviderError",
]);

const THROTTLING_ERRORS = new Set([
  "ThrottlingException",
  "Throttling",
  "RequestLimitExceeded",
  "RequestThrottledException",
  "TooManyRequestsException",
]);

const MISSING_RESOURCE_ERRORS = new Set([
  "ClusterNotFoundException",
  "ServiceNotFoundException",
  "TaskNotFoundException",
  "TaskDefinitionNotFoundException",
  "ResourceNotFoundException",
  "LogGroupNotFoundException",
  "NoSuchBucket",
  "NoSuchKey",
]);

function awsErrorName(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "name" in error &&
    typeof error.name === "string"
    ? error.name
    : undefined;
}

function classifyAwsError(error: unknown): AwsFailureKind {
  const name = awsErrorName(error);
  if (name && AUTHORIZATION_ERRORS.has(name)) return "authorization";
  if (name && THROTTLING_ERRORS.has(name)) return "throttling";
  if (name && MISSING_RESOURCE_ERRORS.has(name)) return "missing-resource";
  const message = platformErrorMessage(error);
  if (/throttl/i.test(message)) return "throttling";
  if (
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network connection|NetworkingError|timeout/i.test(
      message,
    )
  ) {
    return "transport";
  }
  return "unknown";
}

const FAILURE_LEAD: Record<AwsFailureKind, string> = {
  authorization: "AWS authorization failed",
  throttling: "AWS API throttled",
  "missing-resource": "AWS resource not found",
  transport: "AWS transport error",
  unknown: "AWS request failed",
};

/**
 * Convert an AWS SDK error into a typed RuntimeError whose message names the
 * failure category, the attempted operation, and the provider detail. Provider
 * errors are never reported as missing/stopped states, and resolved secret
 * values never appear because AWS messages carry none of them.
 */
function awsOperationError(operation: string, error: unknown): RuntimeError {
  const kind = classifyAwsError(error);
  const hint =
    kind === "authorization"
      ? "; check AWS credentials, region, and IAM permissions for this operation"
      : kind === "throttling"
        ? "; retry after backoff or reduce request rate"
        : kind === "missing-resource"
          ? "; verify the referenced cluster, roles, subnets, security groups, buckets, or keys"
          : "";
  return new RuntimeError({
    message: `${FAILURE_LEAD[kind]} while ${operation}${hint}: ${platformErrorMessage(error)}`,
  });
}

function isAwsErrorNamed(error: unknown, name: string): boolean {
  return awsErrorName(error) === name;
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
    catch: (error) => awsOperationError(`querying ECS task ${taskArn}`, error),
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

/** Render a terminal ECS task state as a distinct, actionable failure. */
function terminalTaskError(taskArn: string, task: Task): RuntimeError {
  const detail = [
    task.stopCode ? `stopCode=${task.stopCode}` : undefined,
    task.stoppedReason ? `reason="${task.stoppedReason}"` : undefined,
    ...(task.containers ?? [])
      .filter((container) => container.exitCode !== undefined && container.exitCode !== 0)
      .map((container) => `${container.name ?? "container"} exited ${container.exitCode}`),
  ]
    .filter(Boolean)
    .join("; ");
  return new RuntimeError({
    message: `ECS task ${taskArn} reached a terminal failure before becoming usable${detail ? `: ${detail}` : ""}`,
  });
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
      awsOperationError(`deregistering ECS task definition ${taskDefinitionArn}`, error),
  }).pipe(Effect.asVoid);
}

function stopEcsTask(ecs: ECSClient, cluster: string, taskArn: string, reason: string) {
  return Effect.tryPromise({
    try: async () => {
      await ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason }));
    },
    catch: (error) => awsOperationError(`stopping ECS task ${taskArn}`, error),
  }).pipe(Effect.asVoid);
}

// --- Typed environment/secret materialization (Plan 05 step 6) ---

export interface MaterializedEnvironment {
  /** Literal plaintext environment injected through the task definition. */
  readonly environment: Array<{ name: string; value: string }>;
  /** Native ECS `secrets` entries; values stay inside AWS at launch time. */
  readonly secrets: Array<{ name: string; valueFrom: string }>;
}

function isValidSecretArn(value: string): boolean {
  return ARN_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * One typed mapper for every declared runtime variable. Literal values become
 * plaintext environment; AWS secret ARN references become native ECS secrets;
 * host-env passthrough references fail clearly because an ECS task has no host
 * to resolve them from. Resolved values never enter manifests, state, events,
 * or errors: literals were already public plan data and ARNs inject server-side.
 */
export function materializeContainerEnvironment(plan: Plan): MaterializedEnvironment {
  const environment: Array<{ name: string; value: string }> = [];
  const secrets: Array<{ name: string; valueFrom: string }> = [];
  const passthrough: string[] = [];

  for (const [key, value] of Object.entries(plan.runtime.environment).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    environment.push({ name: key, value });
  }

  for (const envVar of [...plan.runtime.envVars].sort((a, b) => a.key.localeCompare(b.key))) {
    if (envVar.value !== undefined) {
      environment.push({ name: envVar.key, value: envVar.value });
      continue;
    }
    if (envVar.from && isSecretArnReference(envVar.from)) {
      if (!isValidSecretArn(envVar.from.secretArn)) {
        throw new RuntimeError({
          message: `Environment variable "${envVar.key}" declares an unsupported secret reference. Use a Secrets Manager or SSM Parameter Store ARN (${ARN_PREFIXES.join(" or ")}...).`,
        });
      }
      secrets.push({ name: envVar.key, valueFrom: envVar.from.secretArn });
      continue;
    }
    passthrough.push(envVar.key);
  }

  if (passthrough.length > 0) {
    throw new RuntimeError({
      message: `The aws-ecs target cannot resolve these environment variables from the host: ${passthrough.join(", ")}. Use { secretArn } references (Secrets Manager or SSM Parameter Store) or literal values for this target.`,
    });
  }

  return { environment, secrets };
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
    catch: (error) => awsOperationError(`creating CloudWatch log group ${logGroupName}`, error),
  }).pipe(Effect.asVoid);
}

// --- Hardened container definition (Plan 05 steps 5 and 7) ---

/**
 * Build the single dev-container definition used by every ECS operation.
 *
 * Identity: workload containers run directly as the Plan 04 runtime identity
 * (non-root uid/gid). Deployments hosting supervised daemons keep the Plan 04
 * model in which supervisord starts as root solely to initialize paths and
 * setuid-drop each managed process onto the runtime identity.
 *
 * Filesystem: the root filesystem stays writable because the dev image writes
 * workspace content, logs, harness homes, and artifacts; ownership is confined
 * to the runtime identity by the generated Dockerfile.
 *
 * Networking: Fargate awsvpc gives every task its own ENI; there is no host
 * network mode, no published host ports, and privileged mode is impossible.
 */
function devContainerDefinition(input: {
  readonly plan: Plan;
  readonly imageRef: string;
  readonly command?: string[];
  readonly env: MaterializedEnvironment;
  readonly logGroup: string;
  readonly region: string;
  readonly streamPrefix: string;
  readonly runSupervisorAsRoot: boolean;
}): ContainerDefinition {
  const runtimeIdentity = identitiesOf(input.plan).find((identity) => identity.role === "runtime");
  const user =
    !input.runSupervisorAsRoot && runtimeIdentity
      ? `${runtimeIdentity.uid}:${runtimeIdentity.gid}`
      : undefined;

  return {
    name: "dev",
    image: input.imageRef,
    essential: true,
    command: input.command,
    user,
    environment: input.env.environment.map((entry) => ({ name: entry.name, value: entry.value })),
    secrets: input.env.secrets.length > 0 ? input.env.secrets : undefined,
    logConfiguration: {
      logDriver: "awslogs",
      options: {
        "awslogs-group": input.logGroup,
        "awslogs-region": input.region,
        "awslogs-stream-prefix": input.streamPrefix,
      },
    },
    readonlyRootFilesystem: false,
    privileged: false,
    linuxParameters: {
      initProcessEnabled: true,
    },
  };
}

export function createAwsEcsDriver(
  clients?: AwsClients,
  polling: Partial<EcsPollingPolicy> = {},
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
  const startPolling: EcsPollingPolicy = { ...DEFAULT_START_POLLING, ...polling };

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

  /**
   * Task placement: an explicit capacity provider (e.g. FARGATE_SPOT or a
   * custom EC2 Spot strategy) when configured, on-demand Fargate otherwise.
   */
  function placementFor(
    options: AwsEcsOptions,
  ):
    | { launchType: "FARGATE" }
    | { capacityProviderStrategy: Array<{ capacityProvider: string; weight: number }> } {
    return options.capacityProvider
      ? { capacityProviderStrategy: [{ capacityProvider: options.capacityProvider, weight: 1 }] }
      : { launchType: "FARGATE" };
  }

  function requireState(
    input: RuntimeOperationInput,
    operation: string,
  ): { taskArn?: string; taskDefinitionArn?: string; logGroup?: string } {
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
      return Effect.try({
        try: () => {
          // Validate options and fail before writing artifacts when declared
          // variables cannot be materialized on ECS (host passthrough refs).
          validateAwsEcsOptions(input.target.options);
          materializeContainerEnvironment(input.plan);
          const layout = runtimeLayout(input.rootDir, input.target.name);
          return Array.from(
            Effect.runSync(
              writeArtifacts(input.rootDir, renderCommonArtifacts(input.plan, layout)),
            ),
          );
        },
        catch: (error) =>
          error instanceof RuntimeError
            ? error
            : new RuntimeError({
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
          catch: (error) => awsOperationError("verifying AWS credentials via ECR", error),
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
          catch: (error) => awsOperationError("getting the ECR authorization token", error),
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
        const lgGroup =
          input.state?.resourceIds.logGroup ?? logGroupName(input.plan.project, input.target.name);

        const env = materializeContainerEnvironment(input.plan);
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
                  devContainerDefinition({
                    plan: input.plan,
                    imageRef,
                    command: defaultCommand,
                    env,
                    logGroup: lgGroup,
                    region: opts.region,
                    streamPrefix: input.deploymentId,
                    runSupervisorAsRoot: hasDaemonProcesses,
                  }),
                ],
              }),
            ),
          catch: (error) => awsOperationError(`registering ECS task definition ${family}`, error),
        });

        const taskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
        if (!taskDefArn) {
          return yield* new RuntimeError({
            message: "ECS RegisterTaskDefinition returned no task definition ARN",
          });
        }

        // Provisional identity is durable before any waiting: an interrupted
        // start leaves recoverable state naming every created resource.
        const createdAt = new Date().toISOString();
        const resourceIds = {
          taskDefinitionArn: taskDefArn,
          taskArn: "",
          logGroup: lgGroup,
          logStreamPrefix: input.deploymentId,
        };
        writeState(input.rootDir, input.target.name, {
          driver: "aws-ecs",
          deploymentId: input.deploymentId,
          createdAt,
          resourceIds,
          status: "provisioning",
        });

        let taskArn: string | undefined;
        const startup = Effect.gen(function* () {
          const runResult = yield* Effect.tryPromise({
            try: () =>
              c.ecs.send(
                new RunTaskCommand({
                  cluster: opts.cluster,
                  taskDefinition: taskDefArn,
                  ...placementFor(opts),
                  networkConfiguration: {
                    awsvpcConfiguration: {
                      subnets: opts.subnets,
                      securityGroups: opts.securityGroups,
                      assignPublicIp: opts.assignPublicIp ? "ENABLED" : "DISABLED",
                    },
                  },
                }),
              ),
            catch: (error) => awsOperationError(`starting ECS task from ${taskDefArn}`, error),
          });

          const launched = runResult.tasks?.[0]?.taskArn;
          if (!launched) {
            const failures = runResult.failures ?? [];
            const detail =
              failures
                .map(
                  (failure) =>
                    `${failure.reason ?? "?"}${failure.detail ? ` (${failure.detail})` : ""}`,
                )
                .join("; ") || "no task was created";
            return yield* new RuntimeError({
              message: `ECS RunTask failed to place the task from ${taskDefArn}: ${detail}`,
            });
          }
          taskArn = launched;

          writeState(input.rootDir, input.target.name, {
            driver: "aws-ecs",
            deploymentId: input.deploymentId,
            createdAt,
            resourceIds: { ...resourceIds, taskArn: launched },
            status: "provisioning",
          });

          // Bounded, injectable polling until the task is usable or terminal.
          const deadline = Date.now() + startPolling.timeoutMs;
          for (;;) {
            const task = yield* describeEcsTask(c.ecs, opts.cluster, launched);
            if (!task) {
              return yield* new RuntimeError({
                message: `ECS task ${launched} disappeared from cluster ${opts.cluster} before becoming usable`,
              });
            }
            const lastStatus = task.lastStatus ?? "UNKNOWN";
            if (lastStatus === "RUNNING") break;
            if (lastStatus === "STOPPED") {
              return yield* terminalTaskError(launched, task);
            }
            if (Date.now() >= deadline) {
              return yield* new RuntimeError({
                message: `Timed out after ${Math.round(startPolling.timeoutMs / 1000)}s waiting for ECS task ${launched} to reach RUNNING (last status ${lastStatus})`,
              });
            }
            yield* Effect.sleep(`${startPolling.intervalMs} millis`);
          }

          // The deployment is usable: update the provisional record to the
          // final running state atomically before reporting success.
          const finalState: DeploymentState = {
            driver: "aws-ecs",
            deploymentId: input.deploymentId,
            resourceIds: { ...resourceIds, taskArn: launched },
            createdAt,
            status: "running",
          };
          writeState(input.rootDir, input.target.name, finalState);
          return finalState;
        });

        return yield* startup.pipe(
          // Any failed or interrupted start rolls back every created resource:
          // the task (if placed) is stopped and the task definition deregistered.
          Effect.onError(() =>
            Effect.gen(function* () {
              if (taskArn) {
                yield* bestEffortCleanup(
                  stopEcsTask(
                    c.ecs,
                    opts.cluster,
                    taskArn,
                    "Rolled back by biodome after failed start",
                  ),
                  `Failed to stop ECS task ${taskArn} during rollback`,
                );
              }
              yield* bestEffortCleanup(
                deregisterTaskDefinition(c.ecs, taskDefArn),
                `Failed to deregister leaked task definition ${taskDefArn} after failed start`,
              );
              removeState(input.rootDir, input.target.name);
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (taskArn) {
                yield* bestEffortCleanup(
                  stopEcsTask(c.ecs, opts.cluster, taskArn, "Interrupted biodome start"),
                  `Failed to stop ECS task ${taskArn} after interrupted start`,
                );
              }
              yield* bestEffortCleanup(
                deregisterTaskDefinition(c.ecs, taskDefArn),
                `Failed to deregister task definition ${taskDefArn} after interrupted start`,
              );
              removeState(input.rootDir, input.target.name);
            }),
          ),
        );
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

        // Idempotent: a record without a placed task still releases the
        // registered task definition from an interrupted start.
        if (!taskArn) {
          if (taskDefinitionArn) {
            yield* bestEffortCleanup(
              deregisterTaskDefinition(c.ecs, taskDefinitionArn),
              `Failed to deregister task definition ${taskDefinitionArn} during stop`,
            );
          }
          return;
        }

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

        yield* stopFlow;

        // The deployment's own task is terminal, so its dedicated task
        // definition has no remaining active user and is released. Cleanup
        // failures warn instead of masking a successful stop.
        if (taskDefinitionArn) {
          yield* bestEffortCleanup(
            deregisterTaskDefinition(c.ecs, taskDefinitionArn),
            `Failed to deregister ECS task definition ${taskDefinitionArn}`,
          );
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

        const env = materializeContainerEnvironment(input.plan);
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
          const bucket = resolveSecret(opts.artifactBucket, "the S3 artifact bucket");
          taskRoleArn = resolveSecret(opts.taskRoleArn, "the ECS task role ARN");
          env.environment.push({ name: "BIODOME_ARTIFACT_BUCKET", value: bucket });
          env.environment.push({
            name: "BIODOME_ARTIFACT_PREFIX",
            value: opts.artifactPrefix ? opts.artifactPrefix.replace(/\/+$/, "") : "artifacts",
          });
          env.environment.push({ name: "BIODOME_DEPLOYMENT_ID", value: input.deploymentId });
          env.environment.push({
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
                    devContainerDefinition({
                      plan: input.plan,
                      imageRef,
                      command: input.command,
                      env,
                      logGroup: lgGroup,
                      region: opts.region,
                      streamPrefix: `${input.deploymentId}-exec`,
                      // Job commands are plain workloads: never a supervisor.
                      runSupervisorAsRoot: false,
                    }),
                  ],
                }),
              ),
            catch: (error) =>
              awsOperationError(`registering ECS job task definition ${family}-exec`, error),
          });

          const taskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
          if (!taskDefArn) {
            return yield* new RuntimeError({
              message: "ECS RegisterTaskDefinition returned no task definition ARN for the job",
            });
          }
          refs.taskDefArn = taskDefArn;

          const runResult = yield* Effect.tryPromise({
            try: () =>
              c.ecs.send(
                new RunTaskCommand({
                  cluster: opts.cluster,
                  taskDefinition: taskDefArn,
                  ...placementFor(opts),
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
              awsOperationError(`starting the ECS job task from ${taskDefArn}`, error),
          });

          const taskArn = runResult.tasks?.[0]?.taskArn;
          if (!taskArn) {
            const failures = runResult.failures ?? [];
            const detail =
              failures
                .map(
                  (failure) =>
                    `${failure.reason ?? "?"}${failure.detail ? ` (${failure.detail})` : ""}`,
                )
                .join("; ") || "no task was created";
            return yield* new RuntimeError({
              message: `ECS RunTask failed to place the job task from ${taskDefArn}: ${detail}`,
            });
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
                  message: `Failed to poll ECS job task ${taskArn} after ${describeFailures} consecutive DescribeTasks errors: ${described.failure.message}`,
                });
              }
              yield* Effect.sleep(JOB_POLL_INTERVAL);
              continue;
            }
            describeFailures = 0;

            const task = described.success;
            if (!task) {
              return yield* new RuntimeError({
                message: `ECS job task ${taskArn} disappeared from the cluster before reaching a terminal state`,
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
                stopEcsTask(c.ecs, opts.cluster, refs.taskArn, "Timed out waiting for job task"),
                `Failed to stop ECS job task ${refs.taskArn} during cleanup`,
              );
            }
            if (refs.taskDefArn) {
              yield* bestEffortCleanup(
                deregisterTaskDefinition(c.ecs, refs.taskDefArn),
                `Failed to deregister ECS job task definition ${refs.taskDefArn} during cleanup`,
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
        const prefix = opts.artifactPrefix ? opts.artifactPrefix.replace(/\/+$/, "") : "artifacts";
        const c = getClients(opts);
        const s3 = c.s3 ?? new S3Client({ region: opts.region });

        const artifactsDir = join(input.outputDir, "artifacts");
        mkdirSync(artifactsDir, { recursive: true });

        const artifacts: Artifact[] = [];
        for (const requestedPath of input.paths) {
          // Declared artifact keys are workspace-relative POSIX paths.
          yield* Effect.try({
            try: () => assertRelativeArtifactPath(requestedPath),
            catch: toRuntimeError,
          });
          const s3Key = `${prefix}/${input.deploymentId}/${requestedPath}`;
          const localPath = join(artifactsDir, requestedPath);
          mkdirSync(dirname(localPath), { recursive: true });

          const response = yield* Effect.tryPromise({
            try: async () => {
              let res: GetObjectCommandOutput;
              try {
                res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
              } catch (error) {
                const name = awsErrorName(error);
                if (name === "NoSuchKey") {
                  throw new RuntimeError({
                    message: `Artifact "${requestedPath}" was not produced by this task (missing s3://${bucket}/${s3Key})`,
                  });
                }
                if (name === "NoSuchBucket") {
                  throw new RuntimeError({
                    message: `Artifact bucket ${bucket} does not exist or is not visible to these credentials`,
                  });
                }
                if (
                  name &&
                  (AUTHORIZATION_ERRORS.has(name) ||
                    /AccessDenied/i.test(platformErrorMessage(error)))
                ) {
                  throw new RuntimeError({
                    message: `S3 authorization failed while downloading artifact "${requestedPath}"; grant s3:GetObject on ${bucket} to the collecting principal: ${platformErrorMessage(error)}`,
                  });
                }
                throw error;
              }
              if (!res.Body) throw new Error(`Empty body for S3 object ${s3Key}`);
              const declaredSize = res.ContentLength;
              if (declaredSize !== undefined && declaredSize > MAX_ARTIFACT_BYTES) {
                throw new RuntimeError({
                  message: `Artifact "${requestedPath}" is ${declaredSize} bytes, exceeding the ${MAX_ARTIFACT_BYTES}-byte collection limit`,
                });
              }
              const byteArray = await res.Body.transformToByteArray();
              if (byteArray.length > MAX_ARTIFACT_BYTES) {
                throw new RuntimeError({
                  message: `Artifact "${requestedPath}" streamed ${byteArray.length} bytes, exceeding the ${MAX_ARTIFACT_BYTES}-byte collection limit`,
                });
              }
              writeFileSync(localPath, byteArray);
              return { sizeBytes: byteArray.length };
            },
            catch: (error) =>
              error instanceof RuntimeError
                ? error
                : awsOperationError(
                    `downloading artifact "${requestedPath}" from s3://${bucket}/${s3Key}`,
                    error,
                  ),
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
        const lgGroup =
          input.state?.resourceIds.logGroup ?? logGroupName(input.plan.project, input.target.name);
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
            awsOperationError(`listing CloudWatch log streams in ${lgGroup}`, error),
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
              awsOperationError(`reading CloudWatch log stream ${stream.logStreamName}`, error),
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
