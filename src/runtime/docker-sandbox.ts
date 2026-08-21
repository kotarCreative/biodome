import { join, relative } from "node:path";
import { Effect } from "effect";
import { generateCompose } from "../docker/generators/compose.js";
import {
  ensureCliAvailable,
  captureTimedExec,
  collectArtifactsByCopying,
  supervisordLogFile,
  supervisorctlArgs,
} from "./driver-kit.js";
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";
import type { Plan, RuntimeTarget } from "../core/plan.js";
import { runtimeLayout } from "./layout.js";
import { renderCommonArtifacts, writeArtifacts } from "./artifacts.js";
import { directoryDigest } from "./build-manifest.js";
import {
  captureCommandOutput,
  execArgsWithTimeout,
  imageRefFromLocalDigest,
  platformErrorMessage,
  runProcess,
  stagingImageRef,
  toRuntimeError,
} from "./proc.js";
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
  return execArgsWithTimeout(["exec", deploymentId], command, timeoutMs);
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

function remoteArtifactPath(input: RuntimeOperationInput, artifact: string): string {
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

function requireSandboxId(input: RuntimeOperationInput): Effect.Effect<string, RuntimeError> {
  return Effect.try({ try: () => sandboxId(input), catch: toRuntimeError });
}

function buildSandboxId(input: RuntimeOperationInput): string {
  return `${input.deploymentId}-build-${directoryDigest(input.outputDir).slice(0, 12)}`;
}

function snapshotWorkspace(id: string): string {
  return `/tmp/biodome-builds/${id}`;
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
    return ensureCliAvailable(
      "sbx",
      "Docker Sandboxes is not available. Install Docker Sandboxes and run `sbx login`.",
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
      yield* runProcess({ command: "sbx", args: ["rm", "--force", id], cwd: input.rootDir }).pipe(
        Effect.catch(() => Effect.void),
      );
      yield* runProcess({
        command: "sbx",
        args: buildSbxCreateArgs(id, input.rootDir, options),
        cwd: input.rootDir,
      });
      if (options.clone) {
        const generatedParent = `${sourceWorkspace}/.biodome-build/targets`;
        yield* runProcess({
          command: "sbx",
          args: ["exec", id, "mkdir", "-p", generatedParent],
          cwd: input.rootDir,
        });
        yield* runProcess({
          command: "sbx",
          args: ["cp", input.outputDir, `${id}:${generatedParent}/`],
          cwd: input.rootDir,
        });
      }
      yield* runProcess({
        command: "sbx",
        args: ["exec", id, "mkdir", "-p", workspace],
        cwd: input.rootDir,
      });
      yield* runProcess({
        command: "sbx",
        args: ["exec", id, "cp", "-a", `${sourceWorkspace}/.`, workspace],
        cwd: input.rootDir,
      });
      // Generated task commands use /workspace. Point it at the immutable
      // snapshot rather than the source mount used while constructing it.
      yield* runProcess({
        command: "sbx",
        args: ["exec", id, "sudo", "ln", "-sfnT", workspace, "/workspace"],
        cwd: input.rootDir,
      });
      yield* runProcess({
        command: "sbx",
        args: [
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
        cwd: input.rootDir,
      });
      const digest = yield* captureCommandOutput({
        command: "sbx",
        args: ["exec", id, "docker", "image", "inspect", "--format", "{{.Id}}", stagingImage],
        cwd: input.rootDir,
      });
      const imageRef = imageRefFromLocalDigest(digest);
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
      // Map the container's runtime identity onto the snapshot's owner so
      // task execution can write /workspace without chowning user content.
      const owner = yield* captureCommandOutput({
        command: "sbx",
        args: ["exec", id, "stat", "-c", "%u:%g", workspace],
        cwd: input.rootDir,
      }).pipe(
        Effect.catch(() => Effect.succeed("")),
        Effect.orElseSucceed(() => ""),
      );
      const [ownerUid, ownerGid] = owner.trim().split(":");
      const identityEnv =
        /^\d+$/.test(ownerUid ?? "") && /^\d+$/.test(ownerGid ?? "")
          ? [`BIODOME_RUNTIME_UID=${ownerUid}`, `BIODOME_RUNTIME_GID=${ownerGid}`]
          : [];
      yield* runProcess({
        command: "sbx",
        args: [
          "exec",
          id,
          "env",
          ...identityEnv,
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
        cwd: input.rootDir,
      });
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
      yield* runProcess({
        command: "sbx",
        args: [
          "exec",
          id,
          "docker",
          "compose",
          "-f",
          composeFile,
          "-p",
          input.deploymentId,
          "down",
        ],
        cwd: input.rootDir,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            console.warn(
              `[biodome] Tolerated failure stopping compose project ${input.deploymentId} in sandbox ${id}: ${error.message}`,
            ),
          ),
        ),
      );
      yield* runProcess({ command: "sbx", args: ["rm", "--force", id], cwd: input.rootDir });
    });
  },

  exec(
    input: RuntimeOperationInput & { command: string[]; timeoutMs?: number },
  ): Effect.Effect<CommandResult, RuntimeError, EventStore> {
    const id = sandboxId(input);
    const command = ["docker", "exec", `${input.deploymentId}-dev`, ...input.command];
    const args = buildSbxExecArgs(id, command, input.timeoutMs);
    return captureTimedExec({ command: "sbx", args, cwd: input.rootDir });
  },

  collectArtifacts(
    input: RuntimeOperationInput & { paths: string[] },
  ): Effect.Effect<Artifact[], RuntimeError, EventStore> {
    return Effect.gen(function* () {
      const id = yield* requireSandboxId(input);
      return yield* collectArtifactsByCopying({
        outputDir: input.outputDir,
        paths: input.paths,
        copy: (path, localPath) =>
          captureCommandOutput({
            command: "sbx",
            args: ["cp", `${id}:${remoteArtifactPath(input, path)}`, localPath],
          }),
        describeMissing: (path) => `Artifact "${path}" was not found in sandbox ${id}`,
      });
    });
  },

  status(input: RuntimeOperationInput): Effect.Effect<StatusResult, RuntimeError, EventStore> {
    return Effect.gen(function* () {
      const id = yield* requireSandboxId(input);
      const output = yield* captureCommandOutput({
        command: "sbx",
        args: ["ls", "--json"],
        cwd: input.rootDir,
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new RuntimeError({
              message: `Failed to query Docker Sandbox status: ${error.message}`,
            }),
          ),
        ),
      );
      return parseSbxListOutput(output, id);
    });
  },

  logs(
    input: RuntimeOperationInput & { processName?: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    const logDir = runtimeLayout(input.rootDir, input.target.name).container.logs;
    const logFile = supervisordLogFile(logDir, input.processName);
    const id = sandboxId(input);
    return runProcess({
      command: "sbx",
      args: ["exec", id, "docker", "exec", `${input.deploymentId}-dev`, "tail", "-f", logFile],
      cwd: input.rootDir,
    });
  },

  restart(
    input: RuntimeOperationInput & { processName: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    const id = sandboxId(input);
    return runProcess({
      command: "sbx",
      args: [
        "exec",
        id,
        "docker",
        "exec",
        `${input.deploymentId}-dev`,
        ...supervisorctlArgs(
          runtimeLayout(input.rootDir, input.target.name).container.supervisordConfig,
          "restart",
          [input.processName],
        ),
      ],
      cwd: input.rootDir,
    });
  },
};
