import { Command } from "commander";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  buildPlanEffect,
  buildTargetPlanEffect,
  buildTaskPlanEffect,
  validateFeaturesEffect,
  validatePlan,
} from "../builder/index.js";
import { formatInfo, formatAgentsMd } from "../core/info.js";
import { Plan } from "../core/plan.js";
import { getDriver } from "../runtime/registry.js";
import { executeTask } from "../core/task-runner.js";
import { targetBuildDir } from "../runtime/output.js";
import { readState, writeState, removeState } from "../runtime/state.js";
import { hasCapability } from "../core/capabilities.js";
import { PlanError, RuntimeError, SandboxError } from "../core/errors.js";
import { NodeRuntime } from "../core/runtime-node.js";
import { BiodomeTelemetry } from "../core/telemetry.js";
import { detectStarterLanguages, generateStarterFeature, runSafe } from "./helpers.js";
import {
  EventStore,
  FileEventStoreLive,
  NoOpEventStoreLive,
  SandboxEvent,
  eventLogPath,
  formatEvent,
} from "../core/events.js";

const CONFIG_DIR = ".biodome";
const BUILD_DIR = ".biodome-build";

function buildEventStoreLayer(
  rootDir: string,
  enabled: boolean,
  runId: string,
  targetName?: string,
): Layer.Layer<EventStore> {
  if (!enabled) {
    return NoOpEventStoreLive(runId);
  }
  const path = eventLogPath(rootDir, runId, targetName);
  return FileEventStoreLive({ runId, path });
}

function buildLayers(
  rootDir: string,
  enabled: boolean,
  runId: string,
  targetName?: string,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner | EventStore, never, never> {
  return Layer.merge(NodeRuntime, buildEventStoreLayer(rootDir, enabled, runId, targetName));
}

function withLayers<E>(
  program: Effect.Effect<void, E, ChildProcessSpawner.ChildProcessSpawner | EventStore>,
  rootDir: string,
  enabled: boolean,
  runId: string,
  targetName?: string,
): Effect.Effect<void, E, never> {
  return program.pipe(
    Effect.provide(buildLayers(rootDir, enabled, runId, targetName)),
    Effect.provide(BiodomeTelemetry),
  ) as Effect.Effect<void, E, never>;
}

function wrapRunEvents(
  command: string,
  effect: Effect.Effect<void, SandboxError, EventStore | ChildProcessSpawner.ChildProcessSpawner>,
): Effect.Effect<void, SandboxError, EventStore | ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const store = yield* EventStore;
    const start = Date.now();
    yield* store.emit("run.started", { command, cwd: process.cwd() });
    const result = yield* effect.pipe(
      Effect.tap(() => store.emit("run.completed", { command, durationMs: Date.now() - start })),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = error instanceof Error ? error.message : String(error);
          yield* store.emit("run.failed", {
            command,
            durationMs: Date.now() - start,
            error: message,
          });
          yield* store.close();
          return yield* Effect.fail(error);
        }),
      ),
    );
    yield* store.close();
    return result;
  });
}

function emitPlanLoaded(plan: Plan, targetName?: string): Effect.Effect<void, never, EventStore> {
  return Effect.gen(function* () {
    const store = yield* EventStore;
    yield* store.emit("plan.loaded", {
      project: plan.project,
      languages: plan.build.languageRequests.map((l) => l.name),
      services: plan.runtime.services.map((s) => s.name),
      processes: plan.runtime.processes.map((p) => p.name),
      ...(targetName ? { target: targetName } : {}),
    });
  });
}

function emitConfigValidated(
  project: string,
  valid: boolean,
): Effect.Effect<void, never, EventStore> {
  return Effect.gen(function* () {
    const store = yield* EventStore;
    yield* store.emit("config.validated", { project, valid });
  });
}

const program = new Command();
program
  .name("biodome")
  .description("Self-contained development environment manager")
  .version("0.1.0");
program.option("--no-events", "disable structured event capture");

program
  .command("init")
  .description("Initialize the .biodome/ config directory with language auto-detection")
  .option("--bare", "Skip language auto-detection and create a minimal .biodome")
  .action((options) => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const configDir = join(rootDir, CONFIG_DIR);
      const projectName = rootDir.split("/").pop() || "project";

      if (existsSync(configDir)) {
        return yield* new PlanError({
          message: "Config directory .biodome already exists",
        });
      }

      yield* Effect.try({
        try: () => {
          mkdirSync(configDir, { recursive: true });
          writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({ project: { name: projectName } }, null, 2) + "\n",
          );
          writeFileSync(
            join(configDir, "services.mjs"),
            "export default function services(ctx) {\n  // Define backing services here\n}\n",
          );
          mkdirSync(join(configDir, "features"), { recursive: true });

          if (options.bare) {
            writeFileSync(join(configDir, "features", ".gitkeep"), "");
          } else {
            const languages = detectStarterLanguages(rootDir);
            writeFileSync(
              join(configDir, "features", "auto-detect.mjs"),
              generateStarterFeature(languages),
            );
          }

          mkdirSync(join(configDir, "targets"), { recursive: true });
          writeFileSync(
            join(configDir, "targets", "local.mjs"),
            'export default function local(ctx) {\n  ctx.useRuntime("docker-compose");\n}\n',
          );
          mkdirSync(join(configDir, "tasks"), { recursive: true });
          writeFileSync(join(configDir, "tasks", ".gitkeep"), "");
        },
        catch: (error) =>
          new PlanError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });

      yield* Effect.logInfo(`Initialized .biodome config for ${projectName}`);
    });

    runSafe(cliProgram);
  });

// --- Targeted lifecycle commands ---

program
  .command("build <target>")
  .description("Prepare a named target development environment")
  .action((targetName: string) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName);
      yield* emitPlanLoaded(plan, targetName);
      const driver = yield* getDriver(plan.deployment!.target.driver);
      yield* driver.ensureAvailable(plan.deployment!.target);
      const outputDir = targetBuildDir(rootDir, targetName);
      yield* driver.render({ rootDir, outputDir, plan, target: plan.deployment!.target });
      yield* driver.build({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId: plan.deployment!.deploymentId,
      });
      yield* Effect.logInfo(`Target "${targetName}" built`);
    });

    const wrapped = wrapRunEvents("build", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

program
  .command("up <target>")
  .description("Start a named target sandbox")
  .option("--build", "Rebuild the image before starting")
  .option("--wait", "Block until Ctrl+C is pressed")
  .action((targetName: string, options) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName);
      yield* emitPlanLoaded(plan, targetName);
      const driver = yield* getDriver(plan.deployment!.target.driver);
      yield* driver.ensureAvailable(plan.deployment!.target);
      const outputDir = targetBuildDir(rootDir, targetName);
      const deploymentId = plan.deployment!.deploymentId;

      if (options.build) {
        yield* driver.render({ rootDir, outputDir, plan, target: plan.deployment!.target });
        yield* driver.build({
          rootDir,
          outputDir,
          plan,
          target: plan.deployment!.target,
          deploymentId,
        });
      }

      const state = yield* driver.start({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
      });
      writeState(rootDir, targetName, state);

      yield* Effect.logInfo(`Target "${targetName}" is running`);

      if (options.wait) {
        yield* Effect.logInfo("Press Ctrl+C to stop");
        yield* Effect.callback<void, never, never>((resume) => {
          process.on("SIGINT", () => {
            resume(Effect.void);
          });
        });
        yield* driver.stop({
          rootDir,
          outputDir,
          plan,
          target: plan.deployment!.target,
          deploymentId,
        });
        removeState(rootDir, targetName);
      }
    }).pipe(Effect.scoped);

    const wrapped = wrapRunEvents("up", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

program
  .command("down <target>")
  .description("Stop a named target sandbox")
  .action((targetName: string) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName, { dryRun: true });
      const driver = yield* getDriver(plan.deployment!.target.driver);
      const deploymentId = plan.deployment!.deploymentId;
      const outputDir = targetBuildDir(rootDir, targetName);

      readState(rootDir, targetName, deploymentId, driver.id);
      yield* driver.stop({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
      });
      removeState(rootDir, targetName);
      yield* Effect.logInfo(`Target "${targetName}" stopped`);
    });

    const wrapped = wrapRunEvents("down", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

program
  .command("exec <target> <command...>")
  .description("Run a command in a target sandbox container")
  .allowUnknownOption()
  .action((targetName: string, cmd: string[]) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName);
      yield* emitPlanLoaded(plan, targetName);
      const driver = yield* getDriver(plan.deployment!.target.driver);
      if (!hasCapability(driver.capabilities, "exec.command")) {
        return yield* new RuntimeError({
          message: `Driver "${driver.id}" does not support exec.command`,
        });
      }
      const deploymentId = plan.deployment!.deploymentId;
      const outputDir = targetBuildDir(rootDir, targetName);
      yield* driver.exec({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        command: cmd,
        deploymentId,
      });
      yield* Effect.logInfo(`Command completed on target "${targetName}"`);
    }).pipe(Effect.scoped);

    const wrapped = wrapRunEvents("exec", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

program
  .command("info")
  .description(
    "Show project summary: languages, services, endpoints, environment, processes, and connection info",
  )
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildPlanEffect(rootDir, { dryRun: true });
      console.log(formatInfo(plan));
    });

    runSafe(cliProgram);
  });

program
  .command("logs <target> [process]")
  .description("Tail logs from a managed process in a target sandbox")
  .action((targetName: string, processName?: string) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName, { dryRun: true });
      const driver = yield* getDriver(plan.deployment!.target.driver);
      if (!hasCapability(driver.capabilities, "logs.stream")) {
        return yield* new RuntimeError({
          message: `Driver "${driver.id}" does not support logs.stream`,
        });
      }
      const deploymentId = plan.deployment!.deploymentId;
      const outputDir = targetBuildDir(rootDir, targetName);
      yield* driver.logs({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
        processName,
      });
    }).pipe(Effect.scoped);

    const wrapped = wrapRunEvents("logs", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

program
  .command("ps <target>")
  .description("Show running containers for a target sandbox")
  .action((targetName: string) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName, { dryRun: true });
      const driver = yield* getDriver(plan.deployment!.target.driver);
      if (!hasCapability(driver.capabilities, "status.read")) {
        return yield* new RuntimeError({
          message: `Driver "${driver.id}" does not support status.read`,
        });
      }
      const deploymentId = plan.deployment!.deploymentId;
      const outputDir = targetBuildDir(rootDir, targetName);
      const st = yield* driver.status({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
      });
      yield* Effect.logInfo(
        `Target "${targetName}" status: ${st.state}${st.message ? ` - ${st.message}` : ""}`,
      );
    });

    const wrapped = wrapRunEvents("ps", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

program
  .command("status <target>")
  .description("Report container health and process status for a target")
  .action((targetName: string) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName, { dryRun: true });
      const driver = yield* getDriver(plan.deployment!.target.driver);
      if (!hasCapability(driver.capabilities, "status.read")) {
        return yield* new RuntimeError({
          message: `Driver "${driver.id}" does not support status.read`,
        });
      }
      const deploymentId = plan.deployment!.deploymentId;
      const outputDir = targetBuildDir(rootDir, targetName);
      console.log("Container status");
      const st = yield* driver.status({
        rootDir,
        outputDir,
        plan,
        target: plan.deployment!.target,
        deploymentId,
      });
      yield* Effect.logInfo(
        `Target "${targetName}" status: ${st.state}${st.message ? ` - ${st.message}` : ""}`,
      );

      if (hasCapability(driver.capabilities, "process.status")) {
        console.log("\nProcess status");
        yield* driver.exec({
          rootDir,
          outputDir,
          plan,
          target: plan.deployment!.target,
          deploymentId,
          command: [
            "supervisorctl",
            "-c",
            `/workspace/.biodome-build/targets/${targetName}/supervisord.conf`,
            "status",
          ],
        });
      }
    }).pipe(Effect.scoped);

    const wrapped = wrapRunEvents("status", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

program
  .command("restart <target> [process]")
  .description("Restart a managed process or all daemon processes in a target")
  .action((targetName: string, processName?: string) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName);
      yield* emitPlanLoaded(plan, targetName);
      const driver = yield* getDriver(plan.deployment!.target.driver);
      const deploymentId = plan.deployment!.deploymentId;
      const outputDir = targetBuildDir(rootDir, targetName);

      if (processName) {
        if (!hasCapability(driver.capabilities, "process.signal")) {
          return yield* new RuntimeError({
            message: `Driver "${driver.id}" does not support process.signal`,
          });
        }
        yield* driver.restart({
          rootDir,
          outputDir,
          plan,
          target: plan.deployment!.target,
          deploymentId,
          processName,
        });
      } else {
        for (const proc of plan.runtime.processes.filter((p) => p.mode === "daemon")) {
          if (!hasCapability(driver.capabilities, "process.signal")) {
            yield* Effect.logWarning(
              `Driver "${driver.id}" does not support process.signal, skipping ${proc.name}`,
            );
            continue;
          }
          yield* driver.restart({
            rootDir,
            outputDir,
            plan,
            target: plan.deployment!.target,
            deploymentId,
            processName: proc.name,
          });
        }
      }
      yield* Effect.logInfo(`Restart completed on target "${targetName}"`);
    }).pipe(Effect.scoped);

    const wrapped = wrapRunEvents("restart", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

program
  .command("run <target> <task>")
  .description("Execute a named task against a target sandbox")
  .action((targetName: string, taskName: string) => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTaskPlanEffect(rootDir, targetName, taskName);
      const driver = yield* getDriver(plan.deployment!.target.driver);
      yield* driver.ensureAvailable(plan.deployment!.target);
      yield* Effect.logInfo(`Running task "${taskName}" against sandbox "${targetName}"`);
      const result = yield* executeTask(rootDir, plan, driver);
      yield* Effect.logInfo(`Task "${taskName}" completed with exit code ${result.exitCode}`);
      if (result.artifacts && result.artifacts.length > 0) {
        for (const a of result.artifacts) {
          yield* Effect.logInfo(`  Artifact: ${a.path} (${a.sizeBytes} bytes) -> ${a.localPath}`);
        }
      }
    });

    const wrapped = wrapRunEvents("run", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId, targetName));
  });

// --- Non-targeted commands ---

program
  .command("events")
  .description("Show captured structured events for the current project")
  .option("--run <runId>", "Filter to a specific run")
  .action((options) => {
    const cliProgram = Effect.sync(() => {
      const rootDir = process.cwd();
      const buildDir = join(rootDir, BUILD_DIR);

      // Search both global logs and target-scoped logs.
      const logDirs: string[] = [join(buildDir, "logs")];
      const targetsDir = join(buildDir, "targets");
      if (existsSync(targetsDir)) {
        for (const entry of readdirSync(targetsDir)) {
          const targetLogs = join(targetsDir, entry, "logs");
          if (existsSync(targetLogs)) {
            logDirs.push(targetLogs);
          }
        }
      }

      const events: SandboxEvent[] = [];
      for (const logDir of logDirs) {
        if (!existsSync(logDir)) continue;
        const files = readdirSync(logDir).filter(
          (f) => f.startsWith("events-") && f.endsWith(".jsonl"),
        );
        for (const file of files) {
          const text = readFileSync(join(logDir, file), "utf-8");
          for (const line of text.split("\n").filter((l: string) => l.trim().length > 0)) {
            const event = JSON.parse(line) as SandboxEvent;
            events.push(event);
          }
        }
      }

      if (events.length === 0) {
        console.log("No events captured yet");
        return;
      }

      const filtered = options.run ? events.filter((e) => e.runId === options.run) : events;
      filtered
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .forEach((event) => console.log(formatEvent(event)));
    });

    runSafe(cliProgram);
  });

const configCmd = program.command("config").description("Manage sandbox configuration");

configCmd
  .command("validate")
  .description("Validate .biodome/ configuration and feature modules without building")
  .action(() => {
    const runId = randomUUID();
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      yield* validateFeaturesEffect(rootDir);
      const plan = yield* buildPlanEffect(rootDir, { dryRun: true });
      yield* validatePlan(plan);
      yield* emitConfigValidated(plan.project, true);
      yield* Effect.logInfo("Configuration is valid");
    });

    const wrapped = wrapRunEvents("config validate", cliProgram);
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId));
  });

const targetCmd = program.command("target").description("Manage deployment targets");

targetCmd
  .command("validate <target>")
  .description("Validate a named target configuration without building or deploying")
  .action((targetName: string) => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildTargetPlanEffect(rootDir, targetName, { dryRun: true });
      yield* validatePlan(plan);
      yield* Effect.logInfo(`Target "${targetName}" is valid`);
      yield* Effect.logInfo(`  Driver: ${plan.deployment!.target.driver}`);
      yield* Effect.logInfo(`  Deployment ID: ${plan.deployment!.deploymentId}`);
    });

    runSafe(cliProgram);
  });

const generateCmd = program.command("generate").description("Generate project files");

generateCmd
  .command("agents.md")
  .description(
    "Generate AGENTS.md for AI context (languages, services, endpoints, environment, processes)",
  )
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd();
      const plan = yield* buildPlanEffect(rootDir, { dryRun: true });
      writeFileSync(join(rootDir, "AGENTS.md"), formatAgentsMd(plan));
      yield* Effect.logInfo("Generated AGENTS.md");
    });

    runSafe(cliProgram);
  });

program.parse();
