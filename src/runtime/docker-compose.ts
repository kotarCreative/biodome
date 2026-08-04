import { mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { Effect, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { NodeRuntime } from "../core/runtime-node.js";
import { generateCompose } from "../docker/generator.js";
import { parseServiceStatusOutput } from "../docker/runner.js";
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
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";
import { runtimeLayout } from "./layout.js";
import { renderCommonArtifacts, writeArtifacts } from "./artifacts.js";

const COMPOSE_FILE = "docker-compose.yaml";
const COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const TIMEOUT_KILL_AFTER_SECONDS = 5;

function getComposePath(outputDir: string): string {
  return join(outputDir, COMPOSE_FILE);
}

function platformErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}

export function buildDockerExecArgs(
  deploymentId: string,
  command: string[],
  timeoutMs?: number,
): string[] {
  const args = ["exec", `${deploymentId}-dev`];
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

function runDockerCmd(args: string[], cwd?: string): Effect.Effect<void, RuntimeError, never> {
  return Effect.gen(function* () {
    const handle = yield* ChildProcess.make("docker", args, {
      cwd,
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
    Effect.catch((error) =>
      Effect.fail(
        error instanceof RuntimeError
          ? error
          : new RuntimeError({ message: platformErrorMessage(error as PlatformError) }),
      ),
    ),
  );
}

export const dockerComposeDriver: RuntimeDriver = {
  id: "docker-compose",

  capabilities: capabilitiesOf(
    "lifecycle.build",
    "lifecycle.start",
    "lifecycle.stop",
    "lifecycle.restart",
    "exec.command",
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
    plan: any;
    target: RuntimeTarget;
  }): Effect.Effect<string[], RuntimeError, never> {
    return Effect.try({
      try: () => {
        const layout = runtimeLayout(input.rootDir, input.target.name);
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
      const exitCode = (yield* handle.exitCode) as number;
      if (exitCode !== 0) {
        return yield* new RuntimeError({
          message: "Docker is not available or the daemon is not running.",
        });
      }
    }).pipe(
      Effect.provide(NodeRuntime),
      Effect.scoped,
      Effect.catch((error) =>
        Effect.fail(
          error instanceof RuntimeError
            ? error
            : new RuntimeError({ message: platformErrorMessage(error) }),
        ),
      ),
    );
  },

  build(input: RuntimeOperationInput): Effect.Effect<BuildResult, RuntimeError, EventStore> {
    return runDockerCmd(
      ["compose", "-f", getComposePath(input.outputDir), "-p", input.deploymentId, "build"],
      input.outputDir,
    ).pipe(Effect.map(() => ({})));
  },

  start(input: RuntimeOperationInput): Effect.Effect<DeploymentState, RuntimeError, EventStore> {
    return runDockerCmd(
      [
        "compose",
        "-f",
        getComposePath(input.outputDir),
        "-p",
        input.deploymentId,
        "up",
        "-d",
        "--wait",
      ],
      input.outputDir,
    ).pipe(
      Effect.map(() => ({
        driver: "docker-compose" as const,
        deploymentId: input.deploymentId,
        resourceIds: { project: input.deploymentId },
        createdAt: new Date().toISOString(),
      })),
    );
  },

  stop(input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore> {
    return runDockerCmd(
      ["compose", "-f", getComposePath(input.outputDir), "-p", input.deploymentId, "down"],
      input.outputDir,
    );
  },

  exec(
    input: RuntimeOperationInput & { command: string[]; timeoutMs?: number },
  ): Effect.Effect<CommandResult, RuntimeError, EventStore> {
    const start = Date.now();
    const finalArgs = buildDockerExecArgs(input.deploymentId, input.command, input.timeoutMs);

    return Effect.gen(function* () {
      const handle = yield* ChildProcess.make("docker", finalArgs, {
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
      Effect.catch((error) =>
        Effect.fail(
          error instanceof RuntimeError
            ? error
            : new RuntimeError({ message: platformErrorMessage(error as PlatformError) }),
        ),
      ),
    );
  },

  collectArtifacts(
    input: RuntimeOperationInput & { paths: string[] },
  ): Effect.Effect<Artifact[], RuntimeError, EventStore> {
    return Effect.try({
      try: () => {
        const artifactsDir = join(input.outputDir, "artifacts");
        mkdirSync(artifactsDir, { recursive: true });
        return input.paths.map((path) => {
          if (path.startsWith("/") || path.includes("..")) {
            throw new RuntimeError({
              message: `Invalid artifact path "${path}": must be a relative path without traversal`,
            });
          }
          const localPath = join(artifactsDir, path);
          mkdirSync(dirname(localPath), { recursive: true });
          try {
            execFileSync("docker", [
              "cp",
              `${input.deploymentId}-dev:/workspace/${path}`,
              localPath,
            ]);
          } catch {
            throw new RuntimeError({
              message: `Artifact "${path}" was not found in the container at /workspace/${path}`,
            });
          }
          return { path, localPath, sizeBytes: statSync(localPath).size };
        });
      },
      catch: (error) =>
        error instanceof RuntimeError
          ? error
          : new RuntimeError({
              message: `Failed to collect task artifacts: ${error instanceof Error ? error.message : String(error)}`,
            }),
    });
  },

  status(input: RuntimeOperationInput): Effect.Effect<StatusResult, RuntimeError, EventStore> {
    return Effect.try({
      try: () => {
        const output = execFileSync(
          "docker",
          [
            "compose",
            "-f",
            getComposePath(input.outputDir),
            "-p",
            input.deploymentId,
            "ps",
            "--format",
            "json",
          ],
          { cwd: input.outputDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
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
      },
      catch: (error) =>
        new RuntimeError({
          message: `Failed to query status: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  },

  logs(
    input: RuntimeOperationInput & { processName?: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    const args = input.processName
      ? ["exec", `${input.deploymentId}-dev`, "tail", "-f", `/tmp/${input.processName}.log`]
      : ["exec", `${input.deploymentId}-dev`, "tail", "-f", "/tmp/supervisord.log"];
    return runDockerCmd(args, input.outputDir);
  },

  restart(
    input: RuntimeOperationInput & { processName: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    return runDockerCmd(
      [
        "exec",
        `${input.deploymentId}-dev`,
        "supervisorctl",
        "-c",
        runtimeLayout(input.rootDir, input.target.name).container.supervisordConfig,
        "restart",
        input.processName,
      ],
      input.outputDir,
    );
  },
};
