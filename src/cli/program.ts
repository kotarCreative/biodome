import { randomUUID } from "node:crypto";
import { Command, InvalidArgumentError } from "commander";
import { Effect, Layer } from "effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { provideTelemetry } from "../core/telemetry.js";
import {
  EventStore,
  FileEventStoreLive,
  NoOpEventStoreLive,
  MAX_EVENT_QUERY_LIMIT,
  eventLogPath,
} from "../core/events.js";
import type { SandboxError } from "../core/errors.js";
import { NodeRuntime } from "../core/runtime-node.js";
import { VERSION } from "../core/version.js";
import { runSafe } from "./helpers.js";
import {
  buildWorkflow,
  downWorkflow,
  execWorkflow,
  logsWorkflow,
  psWorkflow,
  restartWorkflow,
  statusWorkflow,
  upWorkflow,
} from "./workflows/target.js";
import { configValidateWorkflow, targetValidateWorkflow } from "./workflows/config.js";
import { envConfigWorkflow } from "./workflows/env.js";
import { eventQuery, eventsWorkflow } from "./workflows/events.js";
import {
  appAddWorkflow,
  appInspectWorkflow,
  appListWorkflow,
  appRemoveWorkflow,
  appValidateWorkflow,
  agentsWorkflow,
  infoWorkflow,
  initWorkflow,
} from "./workflows/project.js";
import { runTaskWorkflow, taskPlanWorkflow } from "./workflows/task.js";

function buildLayers(rootDir: string, enabled: boolean, runId: string, targetName?: string) {
  const events = enabled
    ? FileEventStoreLive({ runId, path: eventLogPath(rootDir, runId, targetName) })
    : NoOpEventStoreLive(runId);
  return Layer.merge(NodeRuntime, events);
}

function withLayers<E>(
  effect: Effect.Effect<void, E, ChildProcessSpawner.ChildProcessSpawner | EventStore>,
  rootDir: string,
  enabled: boolean,
  runId: string,
  targetName?: string,
): Effect.Effect<void, E, never> {
  return effect.pipe(
    Effect.provide(buildLayers(rootDir, enabled, runId, targetName)),
    provideTelemetry,
  ) as Effect.Effect<void, E, never>;
}

function wrapRunEvents(
  command: string,
  effect: Effect.Effect<void, SandboxError, EventStore | ChildProcessSpawner.ChildProcessSpawner>,
) {
  return Effect.gen(function* () {
    const store = yield* EventStore;
    const start = Date.now();
    yield* store.emit("run.started", { command, cwd: process.cwd() });
    const result = yield* effect.pipe(
      Effect.tap(() => store.emit("run.completed", { command, durationMs: Date.now() - start })),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* store.emit("run.failed", {
            command,
            durationMs: Date.now() - start,
            error: error instanceof Error ? error.message : String(error),
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

export interface ProgramDependencies {
  readonly rootDir?: () => string;
  readonly run?: (effect: Effect.Effect<void, SandboxError, never>) => Promise<void>;
  readonly workflows?: {
    readonly init?: typeof initWorkflow;
    readonly build?: typeof buildWorkflow;
    readonly up?: typeof upWorkflow;
    readonly down?: typeof downWorkflow;
    readonly exec?: typeof execWorkflow;
    readonly logs?: typeof logsWorkflow;
    readonly ps?: typeof psWorkflow;
    readonly status?: typeof statusWorkflow;
    readonly restart?: typeof restartWorkflow;
    readonly info?: typeof infoWorkflow;
    readonly appList?: typeof appListWorkflow;
    readonly appInspect?: typeof appInspectWorkflow;
    readonly appValidate?: typeof appValidateWorkflow;
    readonly appAdd?: typeof appAddWorkflow;
    readonly appRemove?: typeof appRemoveWorkflow;
    readonly taskPlan?: typeof taskPlanWorkflow;
    readonly runTask?: typeof runTaskWorkflow;
    readonly events?: typeof eventsWorkflow;
    readonly configValidate?: typeof configValidateWorkflow;
    readonly targetValidate?: typeof targetValidateWorkflow;
    readonly envConfig?: typeof envConfigWorkflow;
    readonly agents?: typeof agentsWorkflow;
  };
}

function parseEventLimit(value: string): number {
  try {
    return eventQuery(undefined, Number(value)).limit;
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const rootDir = dependencies.rootDir ?? process.cwd;
  const run = dependencies.run ?? runSafe;
  const workflows = dependencies.workflows ?? {};
  const program = new Command()
    .name("biodome")
    .description("Self-contained development environment manager")
    .version(VERSION);
  program.option("--no-events", "disable structured event capture");

  const execute = <A>(
    command: string,
    effect: Effect.Effect<A, SandboxError, EventStore | ChildProcessSpawner.ChildProcessSpawner>,
    targetName: string | undefined,
    present: (value: A) => void = () => {},
  ) => {
    const cwd = rootDir();
    const programEffect = Effect.tap(effect, (value) => Effect.sync(() => present(value))).pipe(
      Effect.asVoid,
    );
    return run(
      withLayers(
        wrapRunEvents(command, programEffect),
        cwd,
        program.opts().events,
        randomUUID(),
        targetName,
      ),
    );
  };
  const executePlain = <A>(
    effect: Effect.Effect<A, SandboxError>,
    present: (value: A) => void = () => {},
    failure?: (value: A) => SandboxError | undefined,
  ) =>
    run(
      Effect.gen(function* () {
        const value = yield* effect;
        yield* Effect.sync(() => present(value));
        const error = failure?.(value);
        if (error) return yield* error;
      }) as Effect.Effect<void, SandboxError, never>,
    );
  const logMessage = (value: { message: string }) => {
    console.log(value.message);
  };

  program
    .command("init")
    .description("Initialize the .biodome/ config directory with language auto-detection")
    .option("--bare", "Skip language auto-detection and create a minimal .biodome")
    .action((options) =>
      executePlain((workflows.init ?? initWorkflow)(rootDir(), options.bare), logMessage),
    );
  program
    .command("build <target>")
    .description("Prepare a named target development environment")
    .action((target) =>
      execute("build", (workflows.build ?? buildWorkflow)(rootDir(), target), target, logMessage),
    );
  program
    .command("up <target>")
    .description("Start a named target sandbox")
    .option("--build", "Rebuild the image before starting")
    .option("--wait", "Block until Ctrl+C is pressed")
    .action((target, options) =>
      execute("up", (workflows.up ?? upWorkflow)(rootDir(), target, options), target),
    );
  program
    .command("down <target>")
    .description("Stop a named target sandbox")
    .action((target) =>
      execute("down", (workflows.down ?? downWorkflow)(rootDir(), target), target, logMessage),
    );
  program
    .command("exec <target> <command...")
    .description("Run a command in a target sandbox container")
    .allowUnknownOption()
    .action((target, command) =>
      execute(
        "exec",
        (workflows.exec ?? execWorkflow)(rootDir(), target, command),
        target,
        logMessage,
      ),
    );
  program
    .command("logs <target> [process]")
    .description("Tail logs from a managed process in a target sandbox")
    .action((target, process) =>
      execute("logs", (workflows.logs ?? logsWorkflow)(rootDir(), target, process), target),
    );
  program
    .command("ps <target>")
    .description("Show running containers for a target sandbox")
    .action((target) =>
      execute("ps", (workflows.ps ?? psWorkflow)(rootDir(), target), target, ({ status }) =>
        console.log(
          `Target "${target}" status: ${status.state}${status.message ? ` - ${status.message}` : ""}`,
        ),
      ),
    );
  program
    .command("status <target>")
    .description("Report container health and process status for a target")
    .action((target) =>
      execute(
        "status",
        (workflows.status ?? statusWorkflow)(rootDir(), target),
        target,
        ({ status, hasProcessStatus }) => {
          console.log("Container status");
          console.log(
            `Target "${target}" status: ${status.state}${status.message ? ` - ${status.message}` : ""}`,
          );
          if (hasProcessStatus) console.log("\nProcess status");
        },
      ),
    );
  program
    .command("restart <target> [process]")
    .description("Restart a managed process or all daemon processes in a target")
    .action((target, process) =>
      execute(
        "restart",
        (workflows.restart ?? restartWorkflow)(rootDir(), target, process),
        target,
        logMessage,
      ),
    );

  program
    .command("info")
    .description(
      "Show project summary: languages, services, endpoints, environment, processes, and connection info",
    )
    .action(() => executePlain((workflows.info ?? infoWorkflow)(rootDir()), console.log));
  const app = program.command("app").description("Inspect and manage implicit applications");
  app
    .command("list")
    .description("List implicitly loaded applications")
    .action(() => executePlain((workflows.appList ?? appListWorkflow)(rootDir()), console.log));
  app
    .command("inspect <name>")
    .description("Show an application's expanded primitives and provenance")
    .option("--json", "Print only JSON")
    .action((name, options) =>
      executePlain(
        (workflows.appInspect ?? appInspectWorkflow)(rootDir(), name, options.json),
        console.log,
      ),
    );
  app
    .command("validate")
    .description("Validate services, applications, features, references, and the final plan")
    .action(() =>
      executePlain((workflows.appValidate ?? appValidateWorkflow)(rootDir()), logMessage),
    );
  app
    .command("add <package>")
    .description("Install a trusted npm-distributed app recipe into .biodome")
    .option("--yes", "Acknowledge that app recipes are trusted host-side code")
    .action((packageSpec, options) => {
      if (!options.yes) {
        console.error(
          "App recipes are trusted host-side JavaScript. Re-run with --yes to install.",
        );
        process.exitCode = 1;
        return;
      }
      return executePlain(
        (workflows.appAdd ?? appAddWorkflow)(rootDir(), packageSpec),
        (message) => {
          console.log(message);
          console.log("Create .biodome/apps/<name>.mjs and import the recipe from this package.");
        },
      );
    });
  app
    .command("remove <package>")
    .description("Remove an npm-distributed app recipe from .biodome")
    .action((packageSpec) =>
      executePlain((workflows.appRemove ?? appRemoveWorkflow)(rootDir(), packageSpec), console.log),
    );

  program
    .command("plan <target> <task>")
    .description("Compile a portable task plan and validate it against a target")
    .option("--json", "Print the portable execution plan and compatibility report as JSON")
    .action((target, task, options) =>
      executePlain(
        (workflows.taskPlan ?? taskPlanWorkflow)(rootDir(), target, task),
        (value) =>
          options.json
            ? console.log(
                JSON.stringify(
                  { executionPlan: value.executionPlan, compatibility: value.compatibility },
                  null,
                  2,
                ),
              )
            : console.log(
                `Task: ${value.executionPlan.task.name}\nTarget: ${value.executionPlan.target.name}\n${value.report}`,
              ),
        (value) => value.error,
      ),
    );
  program
    .command("run <target> <task>")
    .description("Execute a named task against a target sandbox")
    .action((target, task) =>
      execute(
        "run",
        (workflows.runTask ?? runTaskWorkflow)(rootDir(), target, task),
        target,
        (result) => {
          console.log(`Task "${task}" completed with exit code ${result.exitCode}`);
          console.log(`Run record: ${result.run.runId}`);
          for (const artifact of result.artifacts ?? [])
            console.log(
              `  Artifact: ${artifact.path} (${artifact.sizeBytes} bytes) -> ${artifact.localPath}`,
            );
        },
      ),
    );
  program
    .command("events")
    .description("Show captured structured events for the current project")
    .option("--run <runId>", "Filter to a specific run")
    .option("--limit <n>", `Maximum events to show (1-${MAX_EVENT_QUERY_LIMIT})`, parseEventLimit)
    .action((options) =>
      executePlain(
        (workflows.events ?? eventsWorkflow)(rootDir(), eventQuery(options.run, options.limit)),
        (lines) => {
          for (const line of lines) console.log(line);
        },
      ),
    );
  const config = program.command("config").description("Manage sandbox configuration");
  config
    .command("validate")
    .description("Validate .biodome/ configuration and feature modules without building")
    .action(() =>
      execute(
        "config validate",
        (workflows.configValidate ?? configValidateWorkflow)(rootDir()),
        undefined,
        logMessage,
      ),
    );
  config
    .command("env [target]")
    .description(
      "Interactively collect environment variables required by targets and save them to .biodome/.env",
    )
    .action((target) =>
      executePlain(
        (workflows.envConfig ?? envConfigWorkflow)(rootDir(), { targetName: target }),
        logMessage,
      ),
    );
  const target = program.command("target").description("Manage deployment targets");
  target
    .command("validate <target>")
    .description("Validate a named target configuration without building or deploying")
    .action((name) =>
      executePlain(
        (workflows.targetValidate ?? targetValidateWorkflow)(rootDir(), name),
        (value) => {
          console.log(`Target "${name}" is valid`);
          console.log(`  Driver: ${value.driver}`);
          console.log(`  Deployment ID: ${value.deploymentId}`);
        },
      ),
    );
  const generate = program.command("generate").description("Generate project files");
  generate
    .command("agents.md")
    .description(
      "Generate AGENTS.md for AI context (languages, services, endpoints, environment, processes)",
    )
    .action(() => executePlain((workflows.agents ?? agentsWorkflow)(rootDir()), logMessage));
  return program;
}
