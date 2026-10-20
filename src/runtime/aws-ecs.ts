import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Exit, Result } from "effect";
import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  DeregisterTaskDefinitionCommand,
  DeleteTaskDefinitionsCommand,
  ListTasksCommand,
  ListTaskDefinitionsCommand,
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
  TargetValidatingDriver,
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
import { needsStartupScript } from "../docker/generators/startup.js";
import { shellQuote } from "../docker/generators/shell.js";
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
const MAX_RECONCILIATION_ATTEMPTS = 5;

/** Hard cap on bytes downloaded per collected artifact object. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

const SECRET_ARN = /^arn:(?:aws|aws-cn|aws-us-gov|aws-iso|aws-iso-b):(secretsmanager|ssm):/;
const IMMUTABLE_IMAGE = /@sha256:[a-f0-9]{64}$/i;

function hasAsyncIterator(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function hasByteArrayTransform(
  value: unknown,
): value is { transformToByteArray(): Promise<Uint8Array> } {
  return (
    value !== null &&
    typeof value === "object" &&
    "transformToByteArray" in value &&
    typeof value.transformToByteArray === "function"
  );
}

/** Incrementally consume an SDK streaming body and stop at the byte cap. */
export async function readArtifactBodyWithinLimit(
  body: unknown,
  artifactPath: string,
  maxBytes = MAX_ARTIFACT_BYTES,
): Promise<Uint8Array> {
  if (hasAsyncIterator(body)) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const value of body) {
      const chunk =
        typeof value === "string"
          ? Buffer.from(value)
          : value instanceof Uint8Array
            ? value
            : undefined;
      if (!chunk) {
        throw new RuntimeError({
          message: `Artifact "${artifactPath}" returned an unsupported streaming body chunk`,
        });
      }
      size += chunk.byteLength;
      if (size > maxBytes) {
        throw new RuntimeError({
          message: `Artifact "${artifactPath}" streamed more than ${maxBytes} bytes, exceeding the collection limit`,
        });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  if (!hasByteArrayTransform(body)) {
    throw new RuntimeError({ message: `Artifact "${artifactPath}" returned an unreadable body` });
  }
  const bytes = await body.transformToByteArray();
  if (bytes.byteLength > maxBytes) {
    throw new RuntimeError({
      message: `Artifact "${artifactPath}" streamed ${bytes.byteLength} bytes, exceeding the ${maxBytes}-byte collection limit`,
    });
  }
  return bytes;
}

function createDefaultClients(region: string): AwsClients {
  return {
    ecr: new ECRClient({ region }),
    ecs: new ECSClient({ region }),
    cloudwatch: new CloudWatchLogsClient({ region }),
    s3: new S3Client({ region }),
  };
}

function ecrAuthorizationCommand(options: AwsEcsOptions): GetAuthorizationTokenCommand {
  const registryId = /^(\d{12})\.dkr\.ecr[.-]/.exec(options.repository)?.[1];
  return new GetAuthorizationTokenCommand(registryId ? { registryIds: [registryId] } : {});
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

function awsRequestMayHaveCommitted(error: unknown): boolean {
  if (classifyAwsError(error) === "transport") return true;
  const name = awsErrorName(error);
  return (
    name === "InternalFailure" ||
    name === "InternalServerError" ||
    name === "ServerException" ||
    name === "ServiceUnavailableException"
  );
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
    try: (signal) =>
      ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }), { abortSignal: signal }),
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

/** Run cleanup without masking the primary failure while retaining its outcome. */
function bestEffortCleanup(
  operation: Effect.Effect<void, RuntimeError>,
  description: string,
): Effect.Effect<boolean, never> {
  return operation.pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.sync(() => {
        console.warn(`[biodome] ${description}: ${error.message}`);
        return false;
      }),
    ),
  );
}

function deregisterTaskDefinition(
  ecs: ECSClient,
  taskDefinitionArn: string,
): Effect.Effect<void, RuntimeError> {
  return Effect.tryPromise({
    try: async (signal) => {
      try {
        await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }), {
          abortSignal: signal,
        });
      } catch (error) {
        if (
          classifyAwsError(error) === "missing-resource" ||
          /not found|does not exist/i.test(platformErrorMessage(error))
        ) {
          return;
        }
        throw error;
      }
    },
    catch: (error) =>
      awsOperationError(`deregistering ECS task definition ${taskDefinitionArn}`, error),
  }).pipe(Effect.asVoid);
}

function deleteTaskDefinition(
  ecs: ECSClient,
  taskDefinitionArn: string,
): Effect.Effect<void, RuntimeError> {
  return Effect.tryPromise({
    try: async (signal) =>
      await ecs.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: [taskDefinitionArn] }), {
        abortSignal: signal,
      }),
    catch: (error) => awsOperationError(`deleting ECS task definition ${taskDefinitionArn}`, error),
  }).pipe(
    Effect.flatMap((response) => {
      const failures = (response?.failures ?? []).filter((failure) => failure.reason !== "MISSING");
      if (failures.length === 0) return Effect.void;
      return Effect.fail(
        new RuntimeError({
          message: `Failed to delete ECS task definition ${taskDefinitionArn}: ${failures
            .map((failure) => failure.reason ?? failure.detail ?? "unknown failure")
            .join("; ")}`,
        }),
      );
    }),
  );
}

function releaseTaskDefinition(
  ecs: ECSClient,
  taskDefinitionArn: string,
): Effect.Effect<void, RuntimeError> {
  return Effect.gen(function* () {
    yield* deregisterTaskDefinition(ecs, taskDefinitionArn);
    yield* deleteTaskDefinition(ecs, taskDefinitionArn);
  });
}

function discoverFamilyResources(
  ecs: ECSClient,
  cluster: string,
  family: string,
): Effect.Effect<{ taskArns: string[]; taskDefinitionArns: string[] }, RuntimeError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const listTasks = async (desiredStatus: "RUNNING" | "STOPPED") => {
        const taskArns: string[] = [];
        let nextToken: string | undefined;
        do {
          const response = await ecs.send(
            new ListTasksCommand({ cluster, family, desiredStatus, nextToken }),
            { abortSignal: signal },
          );
          taskArns.push(...(response.taskArns ?? []));
          nextToken = response.nextToken;
        } while (nextToken);
        return taskArns;
      };
      const listTaskDefinitions = async () => {
        const taskDefinitionArns: string[] = [];
        let nextToken: string | undefined;
        do {
          const response = await ecs.send(
            new ListTaskDefinitionsCommand({
              familyPrefix: family,
              status: "ACTIVE",
              sort: "DESC",
              nextToken,
            }),
            { abortSignal: signal },
          );
          taskDefinitionArns.push(...(response.taskDefinitionArns ?? []));
          nextToken = response.nextToken;
        } while (nextToken);
        return taskDefinitionArns;
      };
      const [running, stopped, definitions] = await Promise.all([
        listTasks("RUNNING"),
        listTasks("STOPPED"),
        listTaskDefinitions(),
      ]);
      return {
        taskArns: [...running, ...stopped],
        taskDefinitionArns: definitions.filter((arn) =>
          arn.includes(`:task-definition/${family}:`),
        ),
      };
    },
    catch: (error) => awsOperationError(`reconciling ECS resources for family ${family}`, error),
  });
}

function discoverFamilyResourcesEventually(
  ecs: ECSClient,
  cluster: string,
  family: string,
  expected: "task" | "task-definition",
  intervalMs: number,
): Effect.Effect<{ taskArns: string[]; taskDefinitionArns: string[] }, RuntimeError> {
  return Effect.gen(function* () {
    for (let attempt = 1; attempt <= MAX_RECONCILIATION_ATTEMPTS; attempt++) {
      const resources = yield* discoverFamilyResources(ecs, cluster, family);
      const found =
        expected === "task"
          ? resources.taskArns.length > 0
          : resources.taskDefinitionArns.length > 0;
      if (found) return resources;
      if (attempt < MAX_RECONCILIATION_ATTEMPTS) {
        yield* Effect.sleep(`${Math.max(1, intervalMs)} millis`);
      }
    }
    return yield* new RuntimeError({
      message: `Could not confirm whether AWS created an ECS ${expected} for family ${family} after a lost response`,
    });
  });
}

function stopEcsTask(ecs: ECSClient, cluster: string, taskArn: string, reason: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      await ecs.send(new StopTaskCommand({ cluster, task: taskArn, reason }), {
        abortSignal: signal,
      });
    },
    catch: (error) => awsOperationError(`stopping ECS task ${taskArn}`, error),
  }).pipe(Effect.asVoid);
}

/** Retry StopTask while a freshly-created task is still propagating through ECS. */
function stopEcsTaskEventually(
  ecs: ECSClient,
  cluster: string,
  taskArn: string,
  reason: string,
): Effect.Effect<void, RuntimeError> {
  return Effect.gen(function* () {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const result = yield* Effect.result(stopEcsTask(ecs, cluster, taskArn, reason));
      if (Result.isSuccess(result)) return;
      const missing = /not found|does not exist|\bMISSING\b/i.test(result.failure.message);
      if (!missing) {
        return yield* result.failure;
      }
      // After the propagation window, durable absence is an idempotent stop.
      if (Date.now() >= deadline) return;
      yield* Effect.sleep("1 second");
    }
  });
}

// --- Typed environment/secret materialization (Plan 05 step 6) ---

export interface MaterializedEnvironment {
  /** Literal plaintext environment injected through the task definition. */
  readonly environment: Array<{ name: string; value: string }>;
  /** Native ECS `secrets` entries; values stay inside AWS at launch time. */
  readonly secrets: Array<{ name: string; valueFrom: string }>;
}

function isValidSecretArn(value: string): boolean {
  return SECRET_ARN.test(value);
}

/**
 * One typed mapper for every declared runtime variable. Literal values become
 * plaintext environment; AWS secret ARN references become native ECS secrets;
 * host-env passthrough references fail clearly because an ECS task has no host
 * to resolve them from. Resolved values never enter manifests, state, events,
 * or errors: literals were already public plan data and ARNs inject server-side.
 */
export function materializeContainerEnvironment(plan: Plan): MaterializedEnvironment {
  const environment = new Map<string, string>();
  const secrets: Array<{ name: string; valueFrom: string }> = [];
  const passthrough: string[] = [];

  for (const [key, value] of Object.entries(plan.runtime.environment).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    environment.set(key, value);
  }

  for (const envVar of [...plan.runtime.envVars].sort((a, b) => a.key.localeCompare(b.key))) {
    if (envVar.scope === "build") continue;
    if (envVar.value !== undefined) {
      environment.set(envVar.key, envVar.value);
      continue;
    }
    if (envVar.from && isSecretArnReference(envVar.from)) {
      if (!isValidSecretArn(envVar.from.secretArn)) {
        throw new RuntimeError({
          message: `Environment variable "${envVar.key}" declares an unsupported secret reference. Use arn:<partition>:secretsmanager:... or arn:<partition>:ssm:... in the target AWS partition.`,
        });
      }
      secrets.push({ name: envVar.key, valueFrom: envVar.from.secretArn });
      continue;
    }
    if (envVar.default !== undefined) {
      environment.set(envVar.key, envVar.default);
    } else if (envVar.required !== false) {
      passthrough.push(envVar.key);
    }
  }

  if (passthrough.length > 0) {
    throw new RuntimeError({
      message: `The aws-ecs target cannot resolve these environment variables from the host: ${passthrough.join(", ")}. Use { secretArn } references (Secrets Manager or SSM Parameter Store) or literal values for this target.`,
    });
  }

  return {
    environment: [...environment.entries()].map(([name, value]) => ({ name, value })),
    secrets,
  };
}

function requireImmutableImageRef(buildManifest: StartInput["buildManifest"]): string {
  const imageRef = buildManifest.imageRef;
  if (
    !imageRef ||
    !IMMUTABLE_IMAGE.test(imageRef) ||
    !imageRef.endsWith(`@${buildManifest.digest}`)
  ) {
    throw new RuntimeError({
      message:
        "The aws-ecs driver requires a build manifest with an immutable repository@sha256 image reference. Rebuild this target before starting it.",
    });
  }
  return imageRef;
}

/**
 * Run a job and, only after it succeeds, publish every declared artifact to
 * the deployment-scoped S3 prefix. The original command remains positional
 * argv rather than interpolated shell text; only already-validated artifact
 * paths are rendered into the uploader script.
 */
function commandWithArtifactUpload(command: string[], artifactPaths: string[]): string[] {
  if (artifactPaths.length === 0) return command;

  const lines = ["job_status=0", '"$@" || job_status=$?', 'if [ "$job_status" -eq 0 ]; then'];
  for (const artifactPath of artifactPaths) {
    const source = shellQuote(`/workspace/${artifactPath}`);
    const destination =
      '"s3://${BIODOME_ARTIFACT_BUCKET}/${BIODOME_ARTIFACT_PREFIX}/${BIODOME_DEPLOYMENT_ID}/"' +
      shellQuote(artifactPath);
    lines.push(`  aws s3 cp ${source} ${destination} --only-show-errors || job_status=$?`);
  }
  lines.push("fi", 'exit "$job_status"');

  return ["sh", "-c", lines.join("\n"), "biodome-artifact-job", ...command];
}

/**
 * Keep provider-native one-shot validation in the same task as the workload so
 * every command observes the workspace mutations made by the preceding one.
 */
function commandWithValidations(command: string[], validationCommands: string[][]): string[] {
  if (validationCommands.length === 0) return command;

  const lines = [
    '"$@"',
    "command_status=$?",
    'if [ "$command_status" -ne 0 ]; then',
    '  exit "$command_status"',
    "fi",
  ];
  for (const validationCommand of validationCommands) {
    if (
      validationCommand.length === 0 ||
      !validationCommand[0] ||
      validationCommand.some((argument) => argument.includes("\0"))
    ) {
      throw new RuntimeError({
        message: "ECS validation commands must name an executable and contain no NUL bytes",
      });
    }
    const rendered = validationCommand.map(shellQuote).join(" ");
    lines.push(
      `if ! ${rendered}; then`,
      `  echo ${shellQuote(`biodome: validation command failed: ${validationCommand.join(" ")}`)} >&2`,
      "  exit 1",
      "fi",
    );
  }

  return ["sh", "-c", lines.join("\n"), "biodome-validated-job", ...command];
}

function ecsClientToken(taskDefinitionArn: string, operation: string): string {
  return createHash("sha256").update(`${operation}:${taskDefinitionArn}`).digest("hex");
}

function persistState(
  rootDir: string,
  targetName: string,
  state: Parameters<typeof writeState>[2],
): Effect.Effect<void, RuntimeError> {
  return Effect.try({
    try: () => writeState(rootDir, targetName, state),
    catch: (error) =>
      new RuntimeError({
        message: `Failed to persist recoverable ECS state for target "${targetName}": ${platformErrorMessage(error)}`,
      }),
  });
}

function removePersistedState(rootDir: string, targetName: string): Effect.Effect<void, never> {
  return Effect.try({
    try: () => removeState(rootDir, targetName),
    catch: toRuntimeError,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        console.warn(
          `[biodome] Failed to remove deployment state for target "${targetName}": ${platformErrorMessage(error)}`,
        ),
      ),
    ),
  );
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
    try: async (signal) => {
      try {
        await cloudwatch.send(new CreateLogGroupCommand({ logGroupName }), {
          abortSignal: signal,
        });
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
 * (non-root uid/gid). Deployments with lifecycle processes keep the Plan 04
 * model in which startup begins as root solely to initialize paths and then
 * setuid-drops hooks, daemons, and job commands onto their declared identity.
 *
 * Filesystem: the root filesystem stays writable because the dev image writes
 * workspace content, logs, and artifacts; ownership is confined
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
  readonly readinessFile: string;
}): ContainerDefinition {
  const runtimeIdentity = identitiesOf(input.plan).find((identity) => identity.role === "runtime");
  const user =
    !input.runSupervisorAsRoot && runtimeIdentity
      ? `${runtimeIdentity.uid}:${runtimeIdentity.gid}`
      : undefined;
  const environment = new Map(
    input.env.environment.map((entry) => [entry.name, entry.value] as const),
  );
  if (input.runSupervisorAsRoot && runtimeIdentity) {
    // Remote tasks always use the image identity. Host uid/gid mapping is a
    // local bind-mount concern and must never be allowed to select uid 0 here.
    environment.set("BIODOME_RUNTIME_UID", String(runtimeIdentity.uid));
    environment.set("BIODOME_RUNTIME_GID", String(runtimeIdentity.gid));
  }

  return {
    name: "dev",
    image: input.imageRef,
    essential: true,
    command: input.command,
    user,
    environment: [...environment].map(([name, value]) => ({ name, value })),
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
      capabilities: input.runSupervisorAsRoot
        ? {
            // Fargate only permits SYS_PTRACE in `add`. Retain the default
            // identity/path setup capabilities and explicitly drop the rest.
            drop: [
              "AUDIT_WRITE",
              "FSETID",
              "KILL",
              "MKNOD",
              "NET_BIND_SERVICE",
              "NET_RAW",
              "SETFCAP",
              "SETPCAP",
              "SYS_CHROOT",
            ],
          }
        : { drop: ["ALL"] },
    },
    healthCheck: {
      command: ["CMD-SHELL", `test -f ${input.readinessFile}`],
      interval: 5,
      timeout: 2,
      retries: 3,
      startPeriod: 300,
    },
  };
}

export function createAwsEcsDriver(
  clients?: AwsClients,
  polling: Partial<EcsPollingPolicy> = {},
): RuntimeDriver &
  AvailableDriver &
  TargetValidatingDriver &
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

  function cloudwatchNamePart(value: string): string {
    const sanitized = value.replace(/[^A-Za-z0-9._/#-]/g, "-");
    if (sanitized === value && sanitized.length <= 200) return sanitized;
    const suffix = createHash("sha256").update(value).digest("hex").slice(0, 12);
    return `${sanitized.slice(0, 187)}-${suffix}`;
  }

  function logGroupName(project: string, targetName: string): string {
    return `/biodome/${cloudwatchNamePart(project)}/${cloudwatchNamePart(targetName)}`;
  }

  /**
   * Task placement: an explicit Fargate capacity provider when configured,
   * on-demand Fargate otherwise.
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
  ): {
    taskArn?: string;
    taskDefinitionArn?: string;
    jobTaskArn?: string;
    jobTaskDefinitionArn?: string;
    taskDefinitionFamily?: string;
    jobTaskDefinitionFamily?: string;
    taskLaunchMayExist?: string;
    jobTaskLaunchMayExist?: string;
    logGroup?: string;
  } {
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
    TargetValidatingDriver &
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

    validateTarget(input): Effect.Effect<void, RuntimeError, never> {
      return Effect.try({
        try: () => {
          validateAwsEcsOptions(input.target.options);
          materializeContainerEnvironment(input.plan);
        },
        catch: (error) =>
          error instanceof RuntimeError
            ? error
            : new RuntimeError({
                message: `Invalid ECS target: ${error instanceof Error ? error.message : String(error)}`,
              }),
      });
    },

    render(input: {
      rootDir: string;
      outputDir: string;
      plan: Plan;
      target: RuntimeTarget;
    }): Effect.Effect<string[], RuntimeError, never> {
      return Effect.try({
        try: () => {
          // Keep render defensive for direct driver consumers. CLI workflows
          // invoke validateTarget before availability checks or provider calls.
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
        const opts = yield* Effect.try({
          try: () => validateAwsEcsOptions(target.options),
          catch: toRuntimeError,
        });
        const c = getClients(opts);
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
          try: async (signal) => {
            await c.ecr.send(ecrAuthorizationCommand(opts), { abortSignal: signal });
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
        const opts = yield* Effect.try({
          try: () => validateAwsEcsOptions(input.target.options),
          catch: toRuntimeError,
        });
        const c = getClients(opts);
        const imageTag = input.deploymentId;
        const fullImage = imageUri(opts, imageTag);

        const temporaryBuildDir = yield* Effect.acquireRelease(
          Effect.try({
            try: () => mkdtempSync(join(tmpdir(), "biodome-buildx-")),
            catch: (error) =>
              new RuntimeError({
                message: `Failed to create Docker Buildx metadata directory: ${platformErrorMessage(error)}`,
              }),
          }),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );
        const dockerConfigDir = join(temporaryBuildDir, "docker-config");
        yield* Effect.try({
          try: () => mkdirSync(dockerConfigDir, { recursive: true, mode: 0o700 }),
          catch: (error) =>
            new RuntimeError({
              message: `Failed to create isolated Docker credential storage: ${platformErrorMessage(error)}`,
            }),
        });
        const dockerEnvironment = { DOCKER_CONFIG: dockerConfigDir };

        const authResponse = yield* Effect.tryPromise({
          try: (signal) => c.ecr.send(ecrAuthorizationCommand(opts), { abortSignal: signal }),
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
              env: { ...process.env, ...dockerEnvironment },
            });
          },
          catch: (error) =>
            new RuntimeError({
              message: `Docker login failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const metadataPath = join(temporaryBuildDir, "metadata.json");
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
            "--provenance=false",
            "--sbom=false",
            "--metadata-file",
            metadataPath,
            "-f",
            join(input.outputDir, "Dockerfile"),
            input.rootDir,
          ],
          env: dockerEnvironment,
        });
        const digest = yield* Effect.try({
          try: () => buildxImageDigest(readFileSync(metadataPath, "utf-8")),
          catch: toRuntimeError,
        });
        return { imageRef: `${opts.repository}@${digest}`, digest };
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    start(input: StartInput): Effect.Effect<DeploymentState, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = yield* Effect.try({
          try: () => validateAwsEcsOptions(input.target.options),
          catch: toRuntimeError,
        });
        const c = getClients(opts);
        const family = familyName(input.deploymentId);
        const lgGroup =
          input.state?.resourceIds.logGroup ?? logGroupName(input.plan.project, input.target.name);

        const env = yield* Effect.try({
          try: () => materializeContainerEnvironment(input.plan),
          catch: toRuntimeError,
        });
        const hasStartupProcesses = needsStartupScript(input.plan);
        const layout = runtimeLayout(input.rootDir, input.target.name).container;
        const readinessFile = `${layout.root}/ready`;
        const defaultCommand = hasStartupProcesses
          ? ["sh", layout.startupScript]
          : ["sh", "-c", `rm -f ${readinessFile} && touch ${readinessFile} && exec sleep infinity`];
        const imageRef = yield* Effect.try({
          try: () => requireImmutableImageRef(input.buildManifest),
          catch: toRuntimeError,
        });
        const roles = yield* Effect.try({
          try: () => ({
            executionRoleArn: resolveSecret(opts.executionRoleArn, "the ECS execution role ARN"),
            taskRoleArn: opts.taskRoleArn
              ? resolveSecret(opts.taskRoleArn, "the ECS task role ARN")
              : undefined,
          }),
          catch: toRuntimeError,
        });

        yield* ensureLogGroup(c.cloudwatch, lgGroup);

        const createdAt = new Date().toISOString();
        let taskDefArn: string | undefined;
        let taskArn: string | undefined;
        let registrationNeedsReconciliation = false;
        let runTaskNeedsReconciliation = false;
        const resourceIds = () => ({
          taskDefinitionArn: taskDefArn ?? "",
          taskArn: taskArn ?? "",
          taskDefinitionFamily: family,
          ...(runTaskNeedsReconciliation ? { taskLaunchMayExist: "true" } : {}),
          logGroup: lgGroup,
          logStreamPrefix: input.deploymentId,
        });

        const rollback = Effect.gen(function* () {
          let cleaned = true;
          const taskArns = new Set(taskArn ? [taskArn] : []);
          const taskDefinitionArns = new Set(taskDefArn ? [taskDefArn] : []);
          if (registrationNeedsReconciliation || runTaskNeedsReconciliation) {
            const discovered = yield* Effect.result(
              discoverFamilyResourcesEventually(
                c.ecs,
                opts.cluster,
                family,
                runTaskNeedsReconciliation ? "task" : "task-definition",
                startPolling.intervalMs,
              ),
            );
            if (Result.isFailure(discovered)) {
              cleaned = false;
              yield* Effect.sync(() => console.warn(`[biodome] ${discovered.failure.message}`));
            } else {
              for (const arn of discovered.success.taskArns) taskArns.add(arn);
              for (const arn of discovered.success.taskDefinitionArns) {
                taskDefinitionArns.add(arn);
              }
              taskArn ??= discovered.success.taskArns[0];
              taskDefArn ??= discovered.success.taskDefinitionArns[0];
            }
          }
          for (const arn of taskArns) {
            cleaned =
              (yield* bestEffortCleanup(
                stopEcsTaskEventually(
                  c.ecs,
                  opts.cluster,
                  arn,
                  "Rolled back by biodome after failed or interrupted start",
                ),
                `Failed to stop ECS task ${arn} during rollback`,
              )) && cleaned;
          }
          for (const arn of taskDefinitionArns) {
            cleaned =
              (yield* bestEffortCleanup(
                releaseTaskDefinition(c.ecs, arn),
                `Failed to release task definition ${arn} during rollback`,
              )) && cleaned;
          }

          if (cleaned && taskDefArn) {
            yield* removePersistedState(input.rootDir, input.target.name);
          } else if (!cleaned) {
            yield* bestEffortCleanup(
              persistState(input.rootDir, input.target.name, {
                driver: "aws-ecs",
                deploymentId: input.deploymentId,
                createdAt,
                resourceIds: resourceIds(),
                status: "failed",
              }),
              `Failed to retain recovery state for target "${input.target.name}"`,
            );
          }
        });

        const startup = Effect.gen(function* () {
          // A returned registration ARN and its first durable state write are
          // uninterruptible; lost AWS responses are reconciled by family below.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const registerResult = yield* Effect.tryPromise({
                try: (signal) =>
                  c.ecs.send(
                    new RegisterTaskDefinitionCommand({
                      family,
                      executionRoleArn: roles.executionRoleArn,
                      taskRoleArn: roles.taskRoleArn,
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
                          runSupervisorAsRoot: hasStartupProcesses,
                          readinessFile,
                        }),
                      ],
                    }),
                    { abortSignal: signal },
                  ),
                catch: (error) => {
                  registrationNeedsReconciliation = awsRequestMayHaveCommitted(error);
                  return awsOperationError(`registering ECS task definition ${family}`, error);
                },
              });

              taskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
              if (!taskDefArn) {
                registrationNeedsReconciliation = true;
                return yield* new RuntimeError({
                  message: "ECS RegisterTaskDefinition returned no task definition ARN",
                });
              }
              registrationNeedsReconciliation = false;
              yield* persistState(input.rootDir, input.target.name, {
                driver: "aws-ecs",
                deploymentId: input.deploymentId,
                createdAt,
                resourceIds: resourceIds(),
                status: "provisioning",
              });
            }),
          );

          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const currentTaskDefArn = taskDefArn;
              if (!currentTaskDefArn) {
                return yield* new RuntimeError({
                  message: "Cannot launch an ECS task before its task definition is recorded",
                });
              }
              const runResult = yield* Effect.tryPromise({
                try: (signal) =>
                  c.ecs.send(
                    new RunTaskCommand({
                      cluster: opts.cluster,
                      taskDefinition: currentTaskDefArn,
                      clientToken: ecsClientToken(currentTaskDefArn, "start"),
                      ...placementFor(opts),
                      networkConfiguration: {
                        awsvpcConfiguration: {
                          subnets: opts.subnets,
                          securityGroups: opts.securityGroups,
                          assignPublicIp: opts.assignPublicIp ? "ENABLED" : "DISABLED",
                        },
                      },
                    }),
                    { abortSignal: signal },
                  ),
                catch: (error) => {
                  runTaskNeedsReconciliation = awsRequestMayHaveCommitted(error);
                  return awsOperationError(`starting ECS task from ${currentTaskDefArn}`, error);
                },
              });

              taskArn = runResult.tasks?.[0]?.taskArn;
              if (!taskArn) {
                runTaskNeedsReconciliation = (runResult.failures ?? []).length === 0;
                const detail =
                  (runResult.failures ?? [])
                    .map(
                      (failure) =>
                        `${failure.reason ?? "?"}${failure.detail ? ` (${failure.detail})` : ""}`,
                    )
                    .join("; ") || "no task was created";
                return yield* new RuntimeError({
                  message: `ECS RunTask failed to place the task from ${currentTaskDefArn}: ${detail}`,
                });
              }
              runTaskNeedsReconciliation = false;

              yield* persistState(input.rootDir, input.target.name, {
                driver: "aws-ecs",
                deploymentId: input.deploymentId,
                createdAt,
                resourceIds: resourceIds(),
                status: "provisioning",
              });
            }),
          );

          // Bounded, injectable polling until the task is usable or terminal.
          const deadline = Date.now() + startPolling.timeoutMs;
          let lastStatus = "MISSING";
          let describeFailures = 0;
          for (;;) {
            const currentTaskArn = taskArn;
            if (!currentTaskArn) {
              return yield* new RuntimeError({
                message: "Cannot poll an ECS task before its task ARN is recorded",
              });
            }
            const described = yield* Effect.result(
              describeEcsTask(c.ecs, opts.cluster, currentTaskArn),
            );
            if (Result.isFailure(described)) {
              describeFailures += 1;
              if (
                /AWS authorization failed|AWS resource not found/.test(described.failure.message) ||
                describeFailures >= MAX_DESCRIBE_FAILURES
              ) {
                return yield* described.failure;
              }
              yield* Effect.sleep(`${startPolling.intervalMs} millis`);
              continue;
            }
            describeFailures = 0;
            const task = described.success;
            if (!task) {
              // RunTask and DescribeTasks are eventually consistent. A MISSING
              // response is retried until the same bounded startup deadline.
              lastStatus = "MISSING";
            } else {
              lastStatus = task.lastStatus ?? "UNKNOWN";
              if (lastStatus === "RUNNING" && task.healthStatus === "HEALTHY") break;
              if (task.healthStatus === "UNHEALTHY") {
                return yield* new RuntimeError({
                  message: `ECS task ${currentTaskArn} became unhealthy before startup completed`,
                });
              }
              if (lastStatus === "STOPPED") {
                return yield* terminalTaskError(currentTaskArn, task);
              }
            }
            if (Date.now() >= deadline) {
              return yield* new RuntimeError({
                message: `Timed out after ${Math.round(startPolling.timeoutMs / 1000)}s waiting for ECS task ${currentTaskArn} to reach RUNNING (last status ${lastStatus})`,
              });
            }
            yield* Effect.sleep(`${startPolling.intervalMs} millis`);
          }

          // The deployment is usable: update the provisional record to the
          // final running state atomically before reporting success.
          const finalState: DeploymentState = {
            driver: "aws-ecs",
            deploymentId: input.deploymentId,
            resourceIds: resourceIds(),
            createdAt,
            status: "running",
          };
          yield* persistState(input.rootDir, input.target.name, finalState);
          return finalState;
        });

        return yield* startup.pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : rollback)),
        );
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = yield* Effect.try({
          try: () => validateAwsEcsOptions(input.target.options),
          catch: toRuntimeError,
        });
        const c = getClients(opts);
        const {
          taskArn,
          taskDefinitionArn,
          taskDefinitionFamily,
          taskLaunchMayExist,
          jobTaskArn,
          jobTaskDefinitionArn,
          jobTaskDefinitionFamily,
          jobTaskLaunchMayExist,
        } = yield* Effect.try({
          try: () => requireState(input, "stop"),
          catch: toRuntimeError,
        });

        const stopAndWait = (arn: string, mayBePropagating: boolean) =>
          Effect.gen(function* () {
            const task = yield* describeEcsTask(c.ecs, opts.cluster, arn);
            if (!task) {
              if (mayBePropagating) {
                yield* stopEcsTaskEventually(c.ecs, opts.cluster, arn, "Stopped by biodome");
              }
              return;
            }
            if (task.lastStatus === "STOPPED") return;

            yield* stopEcsTaskEventually(c.ecs, opts.cluster, arn, "Stopped by biodome");
            for (let i = 0; i < 30; i++) {
              const stoppedTask = yield* describeEcsTask(c.ecs, opts.cluster, arn);
              if (!stoppedTask || stoppedTask.lastStatus === "STOPPED") return;
              if (i < 29) yield* Effect.sleep("2 seconds");
            }
            return yield* new RuntimeError({
              message: `Timed out waiting for ECS task ${arn} to stop`,
            });
          });

        const taskArns = new Set(taskArn ? [taskArn] : []);
        const taskDefinitionArns = new Set(taskDefinitionArn ? [taskDefinitionArn] : []);
        const jobTaskArns = new Set(jobTaskArn ? [jobTaskArn] : []);
        const jobTaskDefinitionArns = new Set(jobTaskDefinitionArn ? [jobTaskDefinitionArn] : []);
        const mayNeedDiscovery =
          input.state?.status === "provisioning" || input.state?.status === "failed";

        if (
          mayNeedDiscovery &&
          taskDefinitionFamily &&
          (!taskDefinitionArn || (!taskArn && taskLaunchMayExist === "true"))
        ) {
          const discovered = yield* discoverFamilyResourcesEventually(
            c.ecs,
            opts.cluster,
            taskDefinitionFamily,
            !taskDefinitionArn ? "task-definition" : "task",
            startPolling.intervalMs,
          );
          for (const arn of discovered.taskArns) taskArns.add(arn);
          for (const arn of discovered.taskDefinitionArns) taskDefinitionArns.add(arn);
        }
        if (
          mayNeedDiscovery &&
          jobTaskDefinitionFamily &&
          (!jobTaskDefinitionArn || (!jobTaskArn && jobTaskLaunchMayExist === "true"))
        ) {
          const discovered = yield* discoverFamilyResourcesEventually(
            c.ecs,
            opts.cluster,
            jobTaskDefinitionFamily,
            !jobTaskDefinitionArn ? "task-definition" : "task",
            startPolling.intervalMs,
          );
          for (const arn of discovered.taskArns) jobTaskArns.add(arn);
          for (const arn of discovered.taskDefinitionArns) jobTaskDefinitionArns.add(arn);
        }

        // A previous job cleanup failure records these references in the same
        // deployment state so `down` can recover them before the base task.
        for (const arn of jobTaskArns) yield* stopAndWait(arn, true);
        for (const arn of jobTaskDefinitionArns) {
          yield* releaseTaskDefinition(c.ecs, arn);
        }

        // Idempotent: a record without a placed task still releases the
        // registered task definition from an interrupted start.
        if (taskArns.size === 0) {
          for (const arn of taskDefinitionArns) yield* releaseTaskDefinition(c.ecs, arn);
          return;
        }

        for (const arn of taskArns) yield* stopAndWait(arn, mayNeedDiscovery);

        // Do not report a successful stop while its definition leaked. The
        // caller retains state when this fails and can safely retry `down`.
        for (const arn of taskDefinitionArns) yield* releaseTaskDefinition(c.ecs, arn);
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    runJob(input: JobInput): Effect.Effect<CommandResult, RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = yield* Effect.try({
          try: () => validateAwsEcsOptions(input.target.options),
          catch: toRuntimeError,
        });
        const c = getClients(opts);
        const family = familyName(input.deploymentId);
        const lgGroup = logGroupName(input.plan.project, input.target.name);
        const imageRef = yield* Effect.try({
          try: () => requireImmutableImageRef(input.buildManifest),
          catch: toRuntimeError,
        });
        const startTime = Date.now();

        // Tracked so the all-exits finalizer below can release ECS resources.
        const refs: {
          taskArn?: string;
          taskDefArn?: string;
          lastStatus: string;
        } = { lastStatus: "PENDING" };
        let registrationNeedsReconciliation = false;
        let runTaskNeedsReconciliation = false;
        const baseState = input.state;
        const persistJobRecoveryState = (): Effect.Effect<void, RuntimeError> =>
          baseState
            ? persistState(input.rootDir, input.target.name, {
                driver: baseState.driver,
                deploymentId: baseState.deploymentId,
                createdAt: baseState.createdAt,
                resourceIds: {
                  ...baseState.resourceIds,
                  jobTaskArn: refs.taskArn ?? "",
                  jobTaskDefinitionArn: refs.taskDefArn ?? "",
                  jobTaskDefinitionFamily: `${family}-exec`,
                  ...(runTaskNeedsReconciliation ? { jobTaskLaunchMayExist: "true" } : {}),
                },
                status: baseState.status,
              })
            : Effect.void;
        const restoreDeploymentState = (): Effect.Effect<void, RuntimeError> =>
          baseState
            ? persistState(input.rootDir, input.target.name, {
                driver: baseState.driver,
                deploymentId: baseState.deploymentId,
                createdAt: baseState.createdAt,
                resourceIds: baseState.resourceIds,
                status: baseState.status,
              })
            : Effect.void;

        const env = yield* Effect.try({
          try: () => materializeContainerEnvironment(input.plan),
          catch: toRuntimeError,
        });
        const roles = yield* Effect.try({
          try: () => ({
            executionRoleArn: resolveSecret(opts.executionRoleArn, "the ECS execution role ARN"),
            taskRoleArn: opts.taskRoleArn
              ? resolveSecret(opts.taskRoleArn, "the ECS task role ARN")
              : undefined,
          }),
          catch: toRuntimeError,
        });
        for (const artifactPath of input.artifactPaths ?? []) {
          yield* Effect.try({
            try: () => assertRelativeArtifactPath(artifactPath),
            catch: toRuntimeError,
          });
        }
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
          const bucket = yield* Effect.try({
            try: () => resolveSecret(opts.artifactBucket, "the S3 artifact bucket"),
            catch: toRuntimeError,
          });
          const setJobEnvironment = (name: string, value: string): void => {
            const existing = env.environment.find((entry) => entry.name === name);
            if (existing) existing.value = value;
            else env.environment.push({ name, value });
          };
          // The AWS CLI does not infer a region from ECS task credentials.
          // Pin both variables so the in-task artifact publisher is
          // deterministic even when the repository declares neither one.
          setJobEnvironment("AWS_REGION", opts.region);
          setJobEnvironment("AWS_DEFAULT_REGION", opts.region);
          setJobEnvironment("BIODOME_ARTIFACT_BUCKET", bucket);
          setJobEnvironment(
            "BIODOME_ARTIFACT_PREFIX",
            opts.artifactPrefix ? opts.artifactPrefix.replace(/\/+$/, "") : "artifacts",
          );
          setJobEnvironment("BIODOME_DEPLOYMENT_ID", input.deploymentId);
          setJobEnvironment("BIODOME_ARTIFACT_PATHS", JSON.stringify(input.artifactPaths));
        }

        const hasStartupProcesses = needsStartupScript(input.plan);
        const layout = runtimeLayout(input.rootDir, input.target.name).container;
        const readinessFile = `${layout.root}/ready`;
        const validatedCommand = yield* Effect.try({
          try: () => commandWithValidations(input.command, input.validationCommands ?? []),
          catch: toRuntimeError,
        });
        const workloadCommand = hasStartupProcesses
          ? ["sh", layout.startupScript, "--job", ...validatedCommand]
          : validatedCommand;
        const jobCommand = commandWithArtifactUpload(workloadCommand, input.artifactPaths ?? []);

        yield* ensureLogGroup(c.cloudwatch, lgGroup);

        const job = Effect.gen(function* () {
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const registerResult = yield* Effect.tryPromise({
                try: (signal) =>
                  c.ecs.send(
                    new RegisterTaskDefinitionCommand({
                      family: `${family}-exec`,
                      executionRoleArn: roles.executionRoleArn,
                      taskRoleArn: roles.taskRoleArn,
                      networkMode: "awsvpc",
                      requiresCompatibilities: ["FARGATE"],
                      cpu: String(opts.cpu ?? 1024),
                      memory: String(opts.memoryMiB ?? 2048),
                      containerDefinitions: [
                        devContainerDefinition({
                          plan: input.plan,
                          imageRef,
                          command: jobCommand,
                          env,
                          logGroup: lgGroup,
                          region: opts.region,
                          streamPrefix: `${input.deploymentId}-exec`,
                          runSupervisorAsRoot: hasStartupProcesses,
                          readinessFile,
                        }),
                      ],
                    }),
                    { abortSignal: signal },
                  ),
                catch: (error) => {
                  registrationNeedsReconciliation = awsRequestMayHaveCommitted(error);
                  return awsOperationError(
                    `registering ECS job task definition ${family}-exec`,
                    error,
                  );
                },
              });

              refs.taskDefArn = registerResult.taskDefinition?.taskDefinitionArn;
              if (!refs.taskDefArn) {
                registrationNeedsReconciliation = true;
                return yield* new RuntimeError({
                  message: "ECS RegisterTaskDefinition returned no task definition ARN for the job",
                });
              }
              registrationNeedsReconciliation = false;
              yield* persistJobRecoveryState();
            }),
          );

          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const taskDefArn = refs.taskDefArn;
              if (!taskDefArn) {
                return yield* new RuntimeError({
                  message: "Cannot launch an ECS job before its task definition is recorded",
                });
              }
              const runResult = yield* Effect.tryPromise({
                try: (signal) =>
                  c.ecs.send(
                    new RunTaskCommand({
                      cluster: opts.cluster,
                      taskDefinition: taskDefArn,
                      clientToken: ecsClientToken(taskDefArn, "job"),
                      ...placementFor(opts),
                      networkConfiguration: {
                        awsvpcConfiguration: {
                          subnets: opts.subnets,
                          securityGroups: opts.securityGroups,
                          assignPublicIp: opts.assignPublicIp ? "ENABLED" : "DISABLED",
                        },
                      },
                    }),
                    { abortSignal: signal },
                  ),
                catch: (error) => {
                  runTaskNeedsReconciliation = awsRequestMayHaveCommitted(error);
                  return awsOperationError(`starting the ECS job task from ${taskDefArn}`, error);
                },
              });

              refs.taskArn = runResult.tasks?.[0]?.taskArn;
              if (!refs.taskArn) {
                runTaskNeedsReconciliation = (runResult.failures ?? []).length === 0;
                const detail =
                  (runResult.failures ?? [])
                    .map(
                      (failure) =>
                        `${failure.reason ?? "?"}${failure.detail ? ` (${failure.detail})` : ""}`,
                    )
                    .join("; ") || "no task was created";
                return yield* new RuntimeError({
                  message: `ECS RunTask failed to place the job task from ${taskDefArn}: ${detail}`,
                });
              }
              runTaskNeedsReconciliation = false;
              yield* persistJobRecoveryState();
            }),
          );

          const taskArn = refs.taskArn;
          if (!taskArn) {
            return yield* new RuntimeError({
              message: "Cannot poll an ECS job before its task ARN is recorded",
            });
          }

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
              refs.lastStatus = "MISSING";
              yield* Effect.sleep(JOB_POLL_INTERVAL);
              continue;
            }

            refs.lastStatus = task.lastStatus || "UNKNOWN";
            if (refs.lastStatus === "STOPPED") {
              const container =
                task.containers?.find((candidate) => candidate.name === "dev") ??
                (task.containers?.length === 1 ? task.containers[0] : undefined);
              if (container?.exitCode === undefined) {
                return yield* terminalTaskError(taskArn, task);
              }
              exitCode = container.exitCode;
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

        return yield* job.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const cleanupErrors: string[] = [];
              const taskArns = new Set(refs.taskArn ? [refs.taskArn] : []);
              const taskDefinitionArns = new Set(refs.taskDefArn ? [refs.taskDefArn] : []);
              if (registrationNeedsReconciliation || runTaskNeedsReconciliation) {
                const discovered = yield* Effect.result(
                  discoverFamilyResourcesEventually(
                    c.ecs,
                    opts.cluster,
                    `${family}-exec`,
                    runTaskNeedsReconciliation ? "task" : "task-definition",
                    startPolling.intervalMs,
                  ),
                );
                if (Result.isFailure(discovered)) {
                  cleanupErrors.push(discovered.failure.message);
                } else {
                  for (const arn of discovered.success.taskArns) taskArns.add(arn);
                  for (const arn of discovered.success.taskDefinitionArns) {
                    taskDefinitionArns.add(arn);
                  }
                  refs.taskArn ??= discovered.success.taskArns[0];
                  refs.taskDefArn ??= discovered.success.taskDefinitionArns[0];
                  const persisted = yield* Effect.result(persistJobRecoveryState());
                  if (Result.isFailure(persisted)) cleanupErrors.push(persisted.failure.message);
                }
              }
              for (const arn of taskArns) {
                if (arn === refs.taskArn && refs.lastStatus === "STOPPED") continue;
                const stopped = yield* Effect.result(
                  stopEcsTaskEventually(
                    c.ecs,
                    opts.cluster,
                    arn,
                    "Stopped while cleaning up a biodome job task",
                  ),
                );
                if (Result.isFailure(stopped)) cleanupErrors.push(stopped.failure.message);
              }
              for (const arn of taskDefinitionArns) {
                const deregistered = yield* Effect.result(releaseTaskDefinition(c.ecs, arn));
                if (Result.isFailure(deregistered))
                  cleanupErrors.push(deregistered.failure.message);
              }
              if (cleanupErrors.length === 0) {
                const restored = yield* Effect.result(restoreDeploymentState());
                if (Result.isFailure(restored)) cleanupErrors.push(restored.failure.message);
              }
              if (cleanupErrors.length > 0) {
                const message = `Failed to clean up ECS job resources (task ${refs.taskArn ?? "not-created"}, definition ${refs.taskDefArn ?? "not-created"}): ${cleanupErrors.join("; ")}`;
                if (Exit.isSuccess(exit)) return yield* new RuntimeError({ message });
                yield* Effect.sync(() => console.warn(`[biodome] ${message}`));
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) => Effect.fail(toRuntimeError(error))),
      );
    },

    collectArtifacts(
      input: RuntimeOperationInput & { paths: string[]; artifactDir?: string },
    ): Effect.Effect<Artifact[], RuntimeError, EventStore> {
      return Effect.gen(function* () {
        const opts = yield* Effect.try({
          try: () => validateAwsEcsOptions(input.target.options),
          catch: toRuntimeError,
        });
        if (!opts.artifactBucket) {
          return yield* new RuntimeError({
            message:
              "The aws-ecs target does not have artifactBucket configured. Configure artifactBucket in target options to collect task artifacts.",
          });
        }
        const bucket = yield* Effect.try({
          try: () => resolveSecret(opts.artifactBucket, "the S3 artifact bucket"),
          catch: toRuntimeError,
        });
        const prefix = opts.artifactPrefix ? opts.artifactPrefix.replace(/\/+$/, "") : "artifacts";
        const c = getClients(opts);
        const s3 = c.s3 ?? new S3Client({ region: opts.region });

        const artifactsDir = input.artifactDir ?? join(input.outputDir, "artifacts");
        yield* Effect.try({
          try: () => mkdirSync(artifactsDir, { recursive: true }),
          catch: toRuntimeError,
        });

        const artifacts: Artifact[] = [];
        for (const requestedPath of input.paths) {
          // Declared artifact keys are workspace-relative POSIX paths.
          yield* Effect.try({
            try: () => assertRelativeArtifactPath(requestedPath),
            catch: toRuntimeError,
          });
          const s3Key = `${prefix}/${input.deploymentId}/${requestedPath}`;
          const localPath = join(artifactsDir, requestedPath);
          yield* Effect.try({
            try: () => mkdirSync(dirname(localPath), { recursive: true }),
            catch: toRuntimeError,
          });

          const response = yield* Effect.tryPromise({
            try: async (signal) => {
              let res: GetObjectCommandOutput;
              try {
                res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }), {
                  abortSignal: signal,
                });
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
              const byteArray = await readArtifactBodyWithinLimit(res.Body, requestedPath);
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
        const opts = yield* Effect.try({
          try: () => validateAwsEcsOptions(input.target.options),
          catch: toRuntimeError,
        });
        const c = getClients(opts);
        const { taskArn } = yield* Effect.try({
          try: () => requireState(input, "query status"),
          catch: toRuntimeError,
        });

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
            if (task.healthStatus === "UNHEALTHY") {
              return { state: "failed" as const, message: "ECS task is running but unhealthy" };
            }
            if (task.healthStatus !== "HEALTHY") {
              return {
                state: "pending" as const,
                message: "ECS task is running but startup health is not ready",
              };
            }
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
        const opts = yield* Effect.try({
          try: () => validateAwsEcsOptions(input.target.options),
          catch: toRuntimeError,
        });
        const c = getClients(opts);
        const lgGroup =
          input.state?.resourceIds.logGroup ?? logGroupName(input.plan.project, input.target.name);
        const requestsJobLogs =
          input.processName !== undefined &&
          input.plan.deployment?.task?.name === input.processName;
        if (input.processName !== undefined && !requestsJobLogs) {
          return yield* new RuntimeError({
            message: `The aws-ecs driver cannot filter CloudWatch output for supervised process "${input.processName}". Run logs without a process name for aggregate container stdout/stderr; per-process supervisor files are not exported to CloudWatch.`,
          });
        }
        const streamPrefix = requestsJobLogs
          ? `${input.deploymentId}-exec/dev/`
          : `${input.deploymentId}/dev/`;

        const logStreams: Array<{ logStreamName: string; lastEventTimestamp?: number }> = [];
        let nextToken: string | undefined;
        for (let page = 0; page < 20; page++) {
          const streamsResult = yield* Effect.tryPromise({
            try: (signal) =>
              c.cloudwatch.send(
                new DescribeLogStreamsCommand({
                  logGroupName: lgGroup,
                  logStreamNamePrefix: streamPrefix,
                  limit: 50,
                  nextToken,
                }),
                { abortSignal: signal },
              ),
            catch: (error) =>
              awsOperationError(`listing CloudWatch log streams in ${lgGroup}`, error),
          });
          logStreams.push(
            ...(streamsResult.logStreams || []).filter(
              (stream): stream is typeof stream & { logStreamName: string } =>
                typeof stream.logStreamName === "string",
            ),
          );
          if (!streamsResult.nextToken || streamsResult.nextToken === nextToken) break;
          nextToken = streamsResult.nextToken;
        }
        logStreams.sort(
          (left, right) => (right.lastEventTimestamp ?? 0) - (left.lastEventTimestamp ?? 0),
        );
        if (logStreams.length === 0) {
          console.log(`No log streams found matching ${streamPrefix}`);
          return;
        }

        for (const stream of logStreams.slice(0, 3)) {
          const eventsResult = yield* Effect.tryPromise({
            try: (signal) =>
              c.cloudwatch.send(
                new GetLogEventsCommand({
                  logGroupName: lgGroup,
                  logStreamName: stream.logStreamName,
                  limit: 100,
                }),
                { abortSignal: signal },
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
