import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Effect, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { NodeRuntime } from "../core/runtime-node.js";
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";
import type { Plan, RuntimeTarget } from "../core/plan.js";
import { runtimeLayout } from "./layout.js";
import { renderCommonArtifacts, writeArtifacts } from "./artifacts.js";
import { directoryDigest } from "./build-manifest.js";
import { generateCompose } from "../docker/generators/compose.js";
import type {
  Artifact,
  BuildResult,
  CommandResult,
  DeploymentState,
  AvailableDriver,
  ArtifactDriver,
  BuildableDriver,
  ExecutableDriver,
  LogDriver,
  RenderableDriver,
  RestartDriver,
  RuntimeDriver,
  RuntimeOperationInput,
  StartInput,
  StatusDriver,
  StatusResult,
  StartableDriver,
  StoppableDriver,
} from "./driver.js";

const COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const TIMEOUT_KILL_AFTER_SECONDS = 5;

/** Options accepted by Docker's `sbx create` command. */
export interface DockerSandboxOptions {
  /** Agent image family understood by sbx. Defaults to shell. */
  agent?:
    | "claude"
    | "codex"
    | "copilot"
    | "cursor"
    | "docker-agent"
    | "droid"
    | "gemini"
    | "kiro"
    | "opencode"
    | "shell";
  /** A Docker Sandboxes template image. This should contain project dependencies. */
  template?: string;
  /** An experimental Docker Sandboxes kit (directory, zip, or OCI reference). */
  kits?: string[];
  /** Use Docker Sandboxes clone-mode rather than a writable host bind mount. */
  clone?: boolean;
  /** CPU allocation passed through to `sbx create --cpus`. */
  cpus?: number;
  /** Memory allocation such as `8g`, passed through to `sbx create --memory`. */
  memory?: string;
  /** In-container root used for clone mode when it differs from the host project path. */
  cloneWorkspacePath?: string;
}

function platformErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}

function runtimeError(error: unknown): RuntimeError {
  return error instanceof RuntimeError
    ? error
    : new RuntimeError({ message: platformErrorMessage(error) });
}

function dockerSandboxOptions(target: RuntimeTarget): DockerSandboxOptions {
  const options = target.options as DockerSandboxOptions;
  return options ?? {};
}

export function inferSbxAgent(plan: Plan): DockerSandboxOptions["agent"] {
  const harness = plan.deployment?.task?.harness;
  if (!harness) return "shell";
  if (plan.runtime.codexHarnesses.some((item) => item.name === harness)) return "codex";
  if (plan.runtime.claudeHarnesses.some((item) => item.name === harness)) return "claude";
  if (plan.runtime.agentHarnesses.some((item) => item.name === harness)) return "opencode";
  return "shell";
}

function resolvedDockerSandboxOptions(input: RuntimeOperationInput): DockerSandboxOptions {
  const options = dockerSandboxOptions(input.target);
  const workspace = input.executionPlan?.task.workspace.strategy;
  return {
    ...options,
    // Task execution must use the workspace strategy that compatibility
    // validated, rather than an independent target option.
    clone: workspace ? workspace === "clone" : options.clone,
    agent: options.agent ?? inferSbxAgent(input.plan),
  };
}

/** Build the non-interactive `sbx create` invocation for a Biodome deployment. */
export function buildSbxCreateArgs(
  deploymentId: string,
  workspace: string,
  options: DockerSandboxOptions = {},
): string[] {
  const args = ["create", "--name", deploymentId];
  if (options.clone) args.push("--clone");
  if (options.cpus !== undefined) args.push("--cpus", String(options.cpus));
  if (options.memory) args.push("--memory", options.memory);
  if (options.template) args.push("--template", options.template);
  for (const kit of options.kits ?? []) args.push("--kit", kit);
  return [...args, options.agent ?? "shell", workspace];
}

/** Build an `sbx exec` invocation, enforcing command timeouts inside the sandbox. */
export function buildSbxExecArgs(
  deploymentId: string,
  command: string[],
  timeoutMs?: number,
): string[] {
  const args = ["exec", deploymentId];
  if (timeoutMs === undefined) return [...args, ...command];

  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    ...args,
    "timeout",
    "--signal=TERM",
    `--kill-after=${TIMEOUT_KILL_AFTER_SECONDS}s`,
    `${timeoutSeconds}s`,
    ...command,
  ];
}

function collectBoundedOutput(
  stream: Stream.Stream<Uint8Array, PlatformError>,
): Effect.Effect<string, PlatformError> {
  return Stream.runFold(
    stream,
    () => ({ chunks: [] as Uint8Array[], size: 0 }),
    (output, chunk) => {
      const remaining = COMMAND_MAX_BUFFER_BYTES - output.size;
      if (remaining <= 0) return output;
      const retained = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      output.chunks.push(retained);
      output.size += retained.byteLength;
      return output;
    },
  ).pipe(Effect.map(({ chunks, size }) => Buffer.concat(chunks, size).toString("utf8")));
}

function runSbxCmd(args: string[], cwd?: string): Effect.Effect<void, RuntimeError, never> {
  return Effect.gen(function* () {
    const handle = yield* ChildProcess.make("sbx", args, {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = (yield* handle.exitCode) as number;
    if (exitCode !== 0) {
      return yield* new RuntimeError({
        message: `exited with code ${exitCode}`,
        command: `sbx ${args.join(" ")}`,
      });
    }
  }).pipe(
    Effect.provide(NodeRuntime),
    Effect.scoped,
    Effect.catch((error) => Effect.fail(runtimeError(error))),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

interface SandboxListEntry {
  name?: string;
  id?: string;
  status?: string;
  state?: string;
}

function isSandboxListEntry(value: unknown): value is SandboxListEntry {
  return isRecord(value);
}

/**
 * Parse `sbx ls --json` defensively. Docker Sandboxes has used both an array
 * and an object containing a `sandboxes` array in prerelease builds.
 */
export function parseSbxListOutput(output: string, deploymentId: string): StatusResult {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    return { state: "unknown", message: "sbx returned invalid JSON" };
  }

  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sandboxes)
      ? value.sandboxes
      : [];
  const sandbox = entries.find(
    (entry): entry is SandboxListEntry =>
      isSandboxListEntry(entry) && (entry.name === deploymentId || entry.id === deploymentId),
  );
  if (!sandbox) return { state: "unknown", message: "Sandbox not found" };

  const rawState = String(sandbox.status ?? sandbox.state ?? "unknown").toLowerCase();
  if (rawState === "running") return { state: "running" };
  if (rawState === "stopped" || rawState === "exited") return { state: "stopped" };
  if (rawState === "failed" || rawState === "error") return { state: "failed" };
  if (rawState === "pending" || rawState === "creating" || rawState === "starting") {
    return { state: "pending" };
  }
  return { state: "unknown", message: `Sandbox state: ${rawState}` };
}

function artifactPath(input: RuntimeOperationInput, artifact: string): string {
  if (artifact.startsWith("/") || artifact.split(/[\\/]/).includes("..")) {
    throw new RuntimeError({
      message: `Invalid artifact path "${artifact}": must be a relative path without traversal`,
    });
  }
  return join(snapshotWorkspace(sandboxId(input)), artifact);
}

function sandboxId(input: RuntimeOperationInput): string {
  const id = input.state?.resourceIds.sandbox;
  if (!id) {
    throw new RuntimeError({
      message:
        "Docker Sandbox operation requires validated deployment state with a sandbox identity",
    });
  }
  return id;
}

function buildSandboxId(input: RuntimeOperationInput): string {
  return `${input.deploymentId}-build-${directoryDigest(input.outputDir).slice(0, 12)}`;
}

function snapshotWorkspace(id: string): string {
  return `/tmp/biodome-builds/${id}`;
}

function stagingImageRef(input: RuntimeOperationInput): string {
  return `${input.plan.project}-dev:${input.deploymentId}-build`;
}

function imageRefFromDigest(digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new RuntimeError({ message: `Docker returned an invalid image digest: ${digest}` });
  }
  return digest;
}

function runSbxCapture(args: string[], cwd?: string): Effect.Effect<string, RuntimeError, never> {
  return Effect.gen(function* () {
    const handle = yield* ChildProcess.make("sbx", args, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [handle.exitCode, collectBoundedOutput(handle.stdout), collectBoundedOutput(handle.stderr)],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new RuntimeError({
        message: stderr || `exited with code ${exitCode}`,
        command: `sbx ${args.join(" ")}`,
      });
    }
    return stdout.trim();
  }).pipe(
    Effect.provide(NodeRuntime),
    Effect.scoped,
    Effect.catch((error) => Effect.fail(runtimeError(error))),
  );
}

export function translateWorkspaceCommand(
  command: string[],
  rootDir: string,
  options: DockerSandboxOptions = {},
): string[] {
  const workspace = options.clone ? (options.cloneWorkspacePath ?? rootDir) : rootDir;
  return command.map((part) =>
    part === "/workspace" || part.startsWith("/workspace/")
      ? `${workspace}${part.slice("/workspace".length)}`
      : part,
  );
}

/**
 * Docker Sandboxes runtime. The driver deliberately treats templates and kits
 * as prebuilt inputs: `sbx` does not build a sandbox template from a Dockerfile.
 */
export const dockerSandboxDriver: RuntimeDriver &
  AvailableDriver &
  RenderableDriver &
  BuildableDriver &
  StartableDriver &
  StoppableDriver &
  ExecutableDriver &
  ArtifactDriver &
  StatusDriver &
  LogDriver &
  RestartDriver = {
  id: "docker-sandbox",

  capabilities: capabilitiesOf(
    "lifecycle.build",
    "lifecycle.start",
    "lifecycle.stop",
    "exec.inplace",
    "exec.pty",
    "process.signal",
    "logs.stream",
    "status.read",
    "volume.mount",
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
        const layout = runtimeLayout(input.rootDir, input.target.name);
        const buildContext = relative(input.outputDir, input.rootDir) || ".";
        const dockerfile = relative(input.rootDir, layout.host.dockerfile);
        return Array.from(
          Effect.runSync(
            writeArtifacts(input.rootDir, [
              ...renderCommonArtifacts(input.plan, layout),
              {
                relativePath: relative(input.rootDir, layout.host.composeFile),
                content: generateCompose(input.plan, {
                  buildContext,
                  dockerfile,
                  workspace: buildContext,
                }),
              },
            ]),
          ),
        );
      },
      catch: (error) =>
        new RuntimeError({
          message: `Failed to render Docker Sandbox target: ${platformErrorMessage(error)}`,
        }),
    });
  },

  ensureAvailable(): Effect.Effect<void, RuntimeError, EventStore> {
    return Effect.gen(function* () {
      const handle = yield* ChildProcess.make("sbx", ["version"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = (yield* handle.exitCode) as number;
      if (exitCode !== 0) {
        return yield* new RuntimeError({
          message:
            "Docker Sandboxes is not available. Install Docker Sandboxes and run `sbx login`.",
        });
      }
    }).pipe(
      Effect.provide(NodeRuntime),
      Effect.scoped,
      Effect.catch((error) => Effect.fail(runtimeError(error))),
    );
  },

  build(input: RuntimeOperationInput): Effect.Effect<BuildResult, RuntimeError, EventStore> {
    return Effect.gen(function* () {
      const options = resolvedDockerSandboxOptions(input);
      const id = buildSandboxId(input);
      const sourceWorkspace = options.clone
        ? (options.cloneWorkspacePath ?? input.rootDir)
        : input.rootDir;
      const workspace = snapshotWorkspace(id);
      const composeFile = `${workspace}/.biodome-build/targets/${input.target.name}/docker-compose.yaml`;
      const stagingImage = stagingImageRef(input);

      // A content-addressed builder sandbox lets start consume this exact image
      // rather than rebuilding the mutable host workspace.
      yield* runSbxCmd(["rm", "--force", id], input.rootDir).pipe(Effect.catch(() => Effect.void));
      yield* runSbxCmd(buildSbxCreateArgs(id, input.rootDir, options), input.rootDir);
      if (options.clone) {
        const generatedParent = `${sourceWorkspace}/.biodome-build/targets`;
        yield* runSbxCmd(["exec", id, "mkdir", "-p", generatedParent], input.rootDir);
        yield* runSbxCmd(["cp", input.outputDir, `${id}:${generatedParent}/`], input.rootDir);
      }
      yield* runSbxCmd(["exec", id, "mkdir", "-p", workspace], input.rootDir);
      yield* runSbxCmd(["exec", id, "cp", "-a", `${sourceWorkspace}/.`, workspace], input.rootDir);
      // Generated task commands use /workspace. Point it at the immutable
      // snapshot rather than the source mount used while constructing it.
      yield* runSbxCmd(["exec", id, "sudo", "ln", "-sfnT", workspace, "/workspace"], input.rootDir);
      yield* runSbxCmd(
        [
          "exec",
          id,
          "env",
          `BIODOME_DEV_IMAGE=${stagingImage}`,
          "docker",
          "compose",
          "-f",
          composeFile,
          "-p",
          input.deploymentId,
          "build",
        ],
        input.rootDir,
      );
      const digest = yield* runSbxCapture(
        ["exec", id, "docker", "image", "inspect", "--format", "{{.Id}}", stagingImage],
        input.rootDir,
      );
      const imageRef = imageRefFromDigest(digest);
      return { imageRef, digest, provider: { sandbox: id } };
    });
  },

  start(input: StartInput): Effect.Effect<DeploymentState, RuntimeError, EventStore> {
    return Effect.gen(function* () {
      const id = input.buildManifest.provider.sandbox;
      if (!id) {
        return yield* new RuntimeError({
          message: "Docker Sandbox build manifest is missing its builder sandbox identity",
        });
      }
      const imageRef = input.buildManifest.imageRef;
      if (!imageRef) {
        return yield* new RuntimeError({
          message: "Docker Sandbox build manifest is missing its immutable image reference",
        });
      }
      const workspace = snapshotWorkspace(id);
      const composeFile = `${workspace}/.biodome-build/targets/${input.target.name}/docker-compose.yaml`;
      yield* runSbxCmd(
        [
          "exec",
          id,
          "env",
          `BIODOME_DEV_IMAGE=${imageRef}`,
          "docker",
          "compose",
          "-f",
          composeFile,
          "-p",
          input.deploymentId,
          "up",
          "-d",
          "--no-build",
          "--wait",
        ],
        input.rootDir,
      );
      return {
        driver: "docker-sandbox",
        deploymentId: input.deploymentId,
        resourceIds: { sandbox: id },
        createdAt: new Date().toISOString(),
      };
    });
  },

  stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore> {
    const id = sandboxId(input);
    const workspace = snapshotWorkspace(id);
    const composeFile = `${workspace}/.biodome-build/targets/${input.target.name}/docker-compose.yaml`;
    return Effect.gen(function* () {
      yield* runSbxCmd(
        ["exec", id, "docker", "compose", "-f", composeFile, "-p", input.deploymentId, "down"],
        input.rootDir,
      ).pipe(Effect.catch(() => Effect.void));
      yield* runSbxCmd(["rm", "--force", id], input.rootDir);
    });
  },

  exec(
    input: RuntimeOperationInput & { command: string[]; timeoutMs?: number },
  ): Effect.Effect<CommandResult, RuntimeError, EventStore> {
    const start = Date.now();
    const id = sandboxId(input);
    const command = ["docker", "exec", `${input.deploymentId}-dev`, ...input.command];
    const args = buildSbxExecArgs(id, command, input.timeoutMs);
    return Effect.gen(function* () {
      const handle = yield* ChildProcess.make("sbx", args, {
        stdin: input.timeoutMs === undefined ? "inherit" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [handle.exitCode, collectBoundedOutput(handle.stdout), collectBoundedOutput(handle.stderr)],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: exitCode as number,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut: input.timeoutMs !== undefined && exitCode === 124,
      };
    }).pipe(
      Effect.provide(NodeRuntime),
      Effect.scoped,
      Effect.catch((error) => Effect.fail(runtimeError(error))),
    );
  },

  collectArtifacts(
    input: RuntimeOperationInput & { paths: string[] },
  ): Effect.Effect<Artifact[], RuntimeError, EventStore> {
    return Effect.try({
      try: () => {
        const id = sandboxId(input);
        const artifactsDir = join(input.outputDir, "artifacts");
        mkdirSync(artifactsDir, { recursive: true });
        return input.paths.map((path) => {
          const localPath = join(artifactsDir, path);
          mkdirSync(dirname(localPath), { recursive: true });
          try {
            execFileSync("sbx", ["cp", `${id}:${artifactPath(input, path)}`, localPath]);
          } catch {
            throw new RuntimeError({
              message: `Artifact "${path}" was not found in sandbox ${id}`,
            });
          }
          return { path, localPath, sizeBytes: statSync(localPath).size };
        });
      },
      catch: runtimeError,
    });
  },

  status(input: RuntimeOperationInput): Effect.Effect<StatusResult, RuntimeError, EventStore> {
    return Effect.try({
      try: () => {
        const id = sandboxId(input);
        const output = execFileSync("sbx", ["ls", "--json"], {
          cwd: input.rootDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return parseSbxListOutput(output, id);
      },
      catch: (error) =>
        new RuntimeError({
          message: `Failed to query Docker Sandbox status: ${platformErrorMessage(error)}`,
        }),
    });
  },

  logs(
    input: RuntimeOperationInput & { processName?: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    const logFile = input.processName ? `/tmp/${input.processName}.log` : "/tmp/supervisord.log";
    const id = sandboxId(input);
    return runSbxCmd(
      ["exec", id, "docker", "exec", `${input.deploymentId}-dev`, "tail", "-f", logFile],
      input.rootDir,
    );
  },

  restart(
    input: RuntimeOperationInput & { processName: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    const id = sandboxId(input);
    return runSbxCmd(
      [
        "exec",
        id,
        "docker",
        "exec",
        `${input.deploymentId}-dev`,
        "supervisorctl",
        "-c",
        runtimeLayout(input.rootDir, input.target.name).container.supervisordConfig,
        "restart",
        input.processName,
      ],
      input.rootDir,
    );
  },
};
