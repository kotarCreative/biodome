import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { generateCompose } from "../docker/generators/compose.js";
import { parseServiceStatusOutput } from "./compose-status.js";
import {
  ensureCliAvailable,
  captureTimedExec,
  collectArtifactsByCopying,
  supervisordLogFile,
  supervisorctlArgs,
} from "./driver-kit.js";
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
import type { Plan, RuntimeTarget } from "../core/plan.js";
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";
import { runtimeLayout } from "./layout.js";
import { renderCommonArtifacts, writeArtifacts } from "./artifacts.js";
import {
  captureCommandOutput,
  execArgsWithTimeout,
  hostIdentityMappingEnv,
  imageRefFromLocalDigest,
  runProcess,
  stagingImageRef,
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
    return ensureCliAvailable("docker", "Docker is not available or the daemon is not running.");
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
    const finalArgs = buildDockerExecArgs(input.deploymentId, input.command, input.timeoutMs);
    return captureTimedExec({ command: "docker", args: finalArgs });
  },

  collectArtifacts(
    input: RuntimeOperationInput & { paths: string[] },
  ): Effect.Effect<Artifact[], RuntimeError, EventStore> {
    return collectArtifactsByCopying({
      outputDir: input.outputDir,
      paths: input.paths,
      copy: (path, localPath) =>
        captureCommandOutput({
          command: "docker",
          args: ["cp", `${input.deploymentId}-dev:/workspace/${path}`, localPath],
        }),
      describeMissing: (path) =>
        `Artifact "${path}" was not found in the container at /workspace/${path}`,
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
    const args = [
      "exec",
      `${input.deploymentId}-dev`,
      "tail",
      "-f",
      supervisordLogFile(logDir, input.processName),
    ];
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
        ...supervisorctlArgs(
          runtimeLayout(input.rootDir, input.target.name).container.supervisordConfig,
          "restart",
          [input.processName],
        ),
      ],
      cwd: input.outputDir,
    });
  },
};
