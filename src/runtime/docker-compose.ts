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
import { Effect } from "effect";
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
} from "./driver.js";
import type { RuntimeTarget } from "../core/plan.js";
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";

const COMPOSE_FILE = "docker-compose.yaml";

function getComposePath(outputDir: string): string {
  return join(outputDir, COMPOSE_FILE);
}

function platformErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
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
    "process.signal",
    "volume.mount",
  ),

  render(input: {
    rootDir: string;
    outputDir: string;
    plan: any;
    target: RuntimeTarget;
  }): Effect.Effect<string[], RuntimeError, never> {
    return Effect.try({
      try: () => {
        mkdirSync(input.outputDir, { recursive: true });

        const plan = input.plan;
        const files: string[] = [];

        // Dockerfile
        const dockerfilePath = join(input.outputDir, "Dockerfile");
        writeFileSync(dockerfilePath, generateDockerfile(plan));
        files.push(dockerfilePath);

        // supervisord.conf
        const supervisord = generateSupervisordConf(plan);
        if (supervisord) {
          const spPath = join(input.outputDir, "supervisord.conf");
          writeFileSync(spPath, supervisord);
          files.push(spPath);
        }

        // docker-compose.yaml
        const composePath = join(input.outputDir, "docker-compose.yaml");
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
        const healthcheckDir = join(input.outputDir, "healthchecks");
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
        const repoDir = join(input.outputDir, "repos");
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
          const path = join(input.outputDir, name);
          writeBuildFile(path, content);
          files.push(path);
        }
        for (const [name, content] of Object.entries(generatePiHarnessFiles(plan))) {
          const path = join(input.outputDir, name);
          writeBuildFile(path, content);
          files.push(path);
        }
        for (const [name, content] of Object.entries(generateCodexHarnessFiles(plan))) {
          const path = join(input.outputDir, name);
          writeBuildFile(path, content);
          files.push(path);
        }
        for (const [name, content] of Object.entries(generateClaudeHarnessFiles(plan))) {
          const path = join(input.outputDir, name);
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
      ["compose", "-f", getComposePath(input.outputDir), "-p", input.deploymentId, "up", "-d"],
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
    input: RuntimeOperationInput & { command: string[] },
  ): Effect.Effect<CommandResult, RuntimeError, EventStore> {
    const start = Date.now();
    return Effect.gen(function* () {
      const handle = yield* ChildProcess.make(
        "docker",
        ["exec", `${input.deploymentId}-dev`, ...input.command],
        {
          stdin: "inherit",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = (yield* handle.exitCode) as number;
      return {
        exitCode,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - start,
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
          const localPath = join(artifactsDir, path);
          mkdirSync(dirname(localPath), { recursive: true });
          execFileSync("docker", ["cp", `${input.deploymentId}-dev:/workspace/${path}`, localPath]);
          return { path, localPath, sizeBytes: statSync(localPath).size };
        });
      },
      catch: (error) =>
        new RuntimeError({
          message: `Failed to collect task artifacts: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
  },

  status(
    input: RuntimeOperationInput,
  ): Effect.Effect<{ state: string; message?: string }, RuntimeError, EventStore> {
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
        "/workspace/.biodome-build/supervisord.conf",
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
