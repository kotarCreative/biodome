import { mkdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { Effect } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { NodeRuntime } from "../core/runtime-node.js";
import { generateCompose } from "../docker/generators/compose.js";
import { parseServiceStatusOutput } from "./compose-status.js";
import type {
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
  BuildResult,
  DeploymentState,
  CommandResult,
  Artifact,
  StatusDriver,
  StatusResult,
  StartableDriver,
  StoppableDriver,
} from "./driver.js";
import type { Plan, RuntimeTarget } from "../core/plan.js";
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";
import { runtimeLayout } from "./layout.js";
import { renderCommonArtifacts, writeArtifacts } from "./artifacts.js";
import {
  TIMEOUT_EXIT_CODE,
  captureCommandOutput,
  captureProcess,
  execArgsWithTimeout,
  assertProcessName,
  hostIdentityMappingEnv,
  imageRefFromLocalDigest,
  runProcess,
  stagingImageRef,
  toRuntimeError,
} from "./proc.js";

export { imageRefFromLocalDigest };

const COMPOSE_FILE = "docker-compose.yaml";

function getComposePath(outputDir: string): string {
  return join(outputDir, COMPOSE_FILE);
}

export function buildDockerExecArgs(
  deploymentId: string,
  command: string[],
  timeoutMs?: number,
): string[] {
  return execArgsWithTimeout(["exec", `${deploymentId}-dev`], command, timeoutMs);
}

export const dockerComposeDriver: RuntimeDriver &
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
  id: "docker-compose",

  capabilities: capabilitiesOf(
    "lifecycle.build",
    "lifecycle.start",
    "lifecycle.stop",
    "lifecycle.restart",
    "exec.inplace",
    "logs.stream",
    "status.read",
    "process.status",
    "process.signal",
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
        // The workspace is bind-mounted into the container. Creating this
        // private directory on the host keeps it owned and removable by the
        // invoking user even when container processes run as root.
        mkdirSync(layout.host.logs, { recursive: true, mode: 0o700 });
        const plan = input.plan;
        const buildContext = relative(input.outputDir, input.rootDir) || ".";
        const dockerfile = relative(input.rootDir, layout.host.dockerfile);
        const files = [
          ...renderCommonArtifacts(plan, layout),
          {
            relativePath: relative(input.rootDir, layout.host.composeFile),
            content: generateCompose(plan, {
              buildContext,
              dockerfile,
              workspace: buildContext,
            }),
          },
        ];
        return Array.from(Effect.runSync(writeArtifacts(input.rootDir, files)));
      },
      catch: (error) =>
        new RuntimeError({
          message: `Failed to render Docker Compose target: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  },

  ensureAvailable(): Effect.Effect<void, RuntimeError, EventStore> {
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
    }).pipe(
      Effect.provide(NodeRuntime),
      Effect.scoped,
      Effect.catch((error) => Effect.fail(toRuntimeError(error))),
    );
  },

  build(input: RuntimeOperationInput): Effect.Effect<BuildResult, RuntimeError, EventStore> {
    const stagingImage = stagingImageRef(input);
    return Effect.gen(function* () {
      yield* runProcess({
        command: "docker",
        args: ["compose", "-f", getComposePath(input.outputDir), "-p", input.deploymentId, "build"],
        cwd: input.outputDir,
        env: { BIODOME_DEV_IMAGE: stagingImage, ...hostIdentityMappingEnv() },
      });
      const digest = yield* captureCommandOutput({
        command: "docker",
        args: ["image", "inspect", "--format", "{{.Id}}", stagingImage],
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new RuntimeError({
              message: `Failed to inspect Docker image ${stagingImage}: ${error.message}`,
            }),
          ),
        ),
      );
      const imageRef = imageRefFromLocalDigest(digest);
      return { imageRef, digest };
    });
  },

  start(input: StartInput): Effect.Effect<DeploymentState, RuntimeError, EventStore> {
    return Effect.gen(function* () {
      const imageRef = input.buildManifest.imageRef;
      if (!imageRef) {
        return yield* new RuntimeError({
          message: "Docker Compose build manifest is missing its immutable image reference",
        });
      }
      yield* runProcess({
        command: "docker",
        args: [
          "compose",
          "-f",
          getComposePath(input.outputDir),
          "-p",
          input.deploymentId,
          "up",
          "-d",
          "--no-build",
          "--wait",
        ],
        cwd: input.outputDir,
        env: { BIODOME_DEV_IMAGE: imageRef, ...hostIdentityMappingEnv() },
      });
      return {
        driver: "docker-compose" as const,
        deploymentId: input.deploymentId,
        resourceIds: { project: input.deploymentId },
        createdAt: new Date().toISOString(),
      };
    });
  },

  stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore> {
    return runProcess({
      command: "docker",
      args: ["compose", "-f", getComposePath(input.outputDir), "-p", input.deploymentId, "down"],
      cwd: input.outputDir,
    });
  },

  exec(
    input: RuntimeOperationInput & { command: string[]; timeoutMs?: number },
  ): Effect.Effect<CommandResult, RuntimeError, EventStore> {
    const start = Date.now();
    const finalArgs = buildDockerExecArgs(input.deploymentId, input.command, input.timeoutMs);

    return Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* captureProcess({
        command: "docker",
        args: finalArgs,
        stdin: input.timeoutMs === undefined ? "inherit" : "ignore",
      });
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut: input.timeoutMs !== undefined && exitCode === TIMEOUT_EXIT_CODE,
      };
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
      const artifactsDir = join(input.outputDir, "artifacts");
      mkdirSync(artifactsDir, { recursive: true });
      const artifacts: Artifact[] = [];
      for (const path of input.paths) {
        if (path.startsWith("/") || path.includes("..")) {
          return yield* new RuntimeError({
            message: `Invalid artifact path "${path}": must be a relative path without traversal`,
          });
        }
        const localPath = join(artifactsDir, path);
        mkdirSync(dirname(localPath), { recursive: true });
        const copied = yield* Effect.result(
          captureCommandOutput({
            command: "docker",
            args: ["cp", `${input.deploymentId}-dev:/workspace/${path}`, localPath],
          }),
        );
        if (copied._tag === "Failure") {
          return yield* new RuntimeError({
            message: `Artifact "${path}" was not found in the container at /workspace/${path}`,
          });
        }
        artifacts.push({ path, localPath, sizeBytes: statSync(localPath).size });
      }
      return artifacts;
    });
  },

  status(input: RuntimeOperationInput): Effect.Effect<StatusResult, RuntimeError, EventStore> {
    return Effect.gen(function* () {
      const output = yield* captureCommandOutput({
        command: "docker",
        args: [
          "compose",
          "-f",
          getComposePath(input.outputDir),
          "-p",
          input.deploymentId,
          "ps",
          "--format",
          "json",
        ],
        cwd: input.outputDir,
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(new RuntimeError({ message: `Failed to query status: ${error.message}` })),
        ),
      );
      const statuses = parseServiceStatusOutput(output);
      const running = statuses.filter((s) => s.state === "running");
      if (running.length > 0) {
        return { state: "running" as const, message: `${running.length} service(s) running` };
      }
      if (statuses.length > 0) {
        return {
          state: "stopped" as const,
          message: `${statuses.length} service(s) found, none running`,
        };
      }
      return { state: "unknown" as const, message: "No services found" };
    });
  },

  logs(
    input: RuntimeOperationInput & { processName?: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    const logDir = runtimeLayout(input.rootDir, input.target.name).container.logs;
    const name = input.processName ? assertProcessName(input.processName) : undefined;
    const args = name
      ? ["exec", `${input.deploymentId}-dev`, "tail", "-f", `${logDir}/${name}.log`]
      : ["exec", `${input.deploymentId}-dev`, "tail", "-f", `${logDir}/supervisord.log`];
    return runProcess({ command: "docker", args, cwd: input.outputDir });
  },

  restart(
    input: RuntimeOperationInput & { processName: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    return runProcess({
      command: "docker",
      args: [
        "exec",
        `${input.deploymentId}-dev`,
        "supervisorctl",
        "-c",
        runtimeLayout(input.rootDir, input.target.name).container.supervisordConfig,
        "restart",
        input.processName,
      ],
      cwd: input.outputDir,
    });
  },
};
