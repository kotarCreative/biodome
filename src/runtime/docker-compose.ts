import {
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  chmodSync,
  existsSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { NodeRuntime } from "../core/runtime-node.js";
import {
  generateDockerfile,
  generateSupervisordConf,
  generateCompose,
  generateDockerignore,
  generateHealthcheckScripts,
  generateRepoScripts,
  generateHarnessFiles,
  generatePiHarnessFiles,
  generateCodexHarnessFiles,
  generateClaudeHarnessFiles,
} from "../docker/generator.js";
import { generatePlanJson } from "../mcp/generator.js";
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
        mkdirSync(layout.host.root, { recursive: true });

        const plan = input.plan;
        const files: string[] = [];

        // Dockerfile
        const dockerfilePath = layout.host.dockerfile;
        writeFileSync(
          dockerfilePath,
          generateDockerfile(plan, {
            generatedFilesPath: `.biodome-build/targets/${input.target.name}`,
          }),
        );
        files.push(dockerfilePath);

        // supervisord.conf
        const supervisord = generateSupervisordConf(plan);
        if (supervisord) {
          const spPath = layout.host.supervisordConfig;
          writeFileSync(spPath, supervisord);
          files.push(spPath);
        }

        // docker-compose.yaml
        const composePath = layout.host.composeFile;
        const buildContext = relative(input.outputDir, input.rootDir) || ".";
        const dockerfile = relative(input.rootDir, dockerfilePath);
        writeFileSync(
          composePath,
          generateCompose(plan, {
            buildContext,
            dockerfile,
            workspace: buildContext,
          }),
        );
        files.push(composePath);

        // Healthcheck scripts
        const healthcheckDir = layout.host.healthchecks;
        rmSync(healthcheckDir, { recursive: true, force: true });
        mkdirSync(healthcheckDir, { recursive: true });
        const healthchecks = generateHealthcheckScripts(plan);
        for (const [name, content] of Object.entries(healthchecks)) {
          const path = join(healthcheckDir, name);
          writeFileSync(path, content);
          if (content.startsWith("#!/")) chmodSync(path, 0o755);
          files.push(path);
        }

        // Repo scripts
        const repoDir = layout.host.repositories;
        rmSync(repoDir, { recursive: true, force: true });
        mkdirSync(repoDir, { recursive: true });
        const repos = generateRepoScripts(plan);
        for (const [name, content] of Object.entries(repos)) {
          const path = join(repoDir, name);
          writeFileSync(path, content);
          if (content.startsWith("#!/")) chmodSync(path, 0o755);
          files.push(path);
        }

        // Harness files
        for (const [name, content] of Object.entries(generateHarnessFiles(plan))) {
          const path = join(layout.host.root, name);
          writeBuildFile(path, content);
          files.push(path);
        }
        for (const [name, content] of Object.entries(generatePiHarnessFiles(plan))) {
          const path = join(layout.host.root, name);
          writeBuildFile(path, content);
          files.push(path);
        }
        for (const [name, content] of Object.entries(generateCodexHarnessFiles(plan))) {
          const path = join(layout.host.root, name);
          writeBuildFile(path, content);
          files.push(path);
        }
        for (const [name, content] of Object.entries(generateClaudeHarnessFiles(plan))) {
          const path = join(layout.host.root, name);
          writeBuildFile(path, content);
          files.push(path);
        }

        // .dockerignore (project root)
        const dockerignorePath = join(input.rootDir, ".dockerignore");
        if (!existsSync(dockerignorePath)) {
          writeFileSync(dockerignorePath, generateDockerignore());
        }

        // MCP plan and server
        if (plan.build.mcpEnabled) {
          writeFileSync(layout.host.mcpPlan, generatePlanJson(plan));
          const __dirname = dirname(fileURLToPath(import.meta.url));
          const mcpServerSource = join(__dirname, "..", "mcp", "server.js");
          if (existsSync(mcpServerSource)) {
            copyFileSync(mcpServerSource, layout.host.mcpServer);
          }
        }

        return files;
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

function writeBuildFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  if (content.startsWith("#!/")) {
    chmodSync(filePath, 0o755);
  }
}
