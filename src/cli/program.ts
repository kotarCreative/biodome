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
  shellWorkflow,
  upWorkflow,
} from "./workflows/target.js";
import { configValidateWorkflow, targetValidateWorkflow } from "./workflows/config.js";
import { envConfigWorkflow } from "./workflows/env.js";
import { eventQuery, eventsWorkflow, eventPageWorkflow } from "./workflows/events.js";
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
import { CommandOutput } from "../core/command-output.js";

function buildLayers(
  rootDir: string,
  enabled: boolean,
  runId: string,
  targetName?: string,
  stream = false,
) {
  const events = enabled
    ? FileEventStoreLive({
        runId,
        path: eventLogPath(rootDir, runId, targetName),
        target: targetName,
        onEvent: stream
          ? (event) => {
              process.stdout.write(JSON.stringify(event) + "\n");
            }
          : undefined,
      })
    : NoOpEventStoreLive(runId);
  return Layer.merge(NodeRuntime, events);
}

function withLayers<E>(
  effect: Effect.Effect<void, E, ChildProcessSpawner.ChildProcessSpawner | EventStore>,
  rootDir: string,
  enabled: boolean,
  runId: string,
  targetName?: string,
  stream = false,
): Effect.Effect<void, E, never> {
  return effect.pipe(
    Effect.provide(buildLayers(rootDir, enabled, runId, targetName, stream)),
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
    readonly shell?: typeof shellWorkflow;
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

function parseActionInput(value: string): Record<string, unknown> {
  try {
    const input: unknown = JSON.parse(value);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("expected a JSON object");
    }
    return input as Record<string, unknown>;
  } catch (error) {
    throw new InvalidArgumentError(`--input requires a JSON object: ${String(error)}`);
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
    stream = false,
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
        stream,
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
    .command("shell <target>")
    .description("Open an interactive shell in a running environment")
    .action((target) =>
      execute("shell", (workflows.shell ?? shellWorkflow)(rootDir(), target), target),
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
    .command("plan <target> <action>")
    .description("Inspect an environment action without starting anything")
    .option("--json", "Print the portable execution plan and compatibility report as JSON")
    .option("--input <json>", "Merge JSON input into the action defaults", parseActionInput)
    .option("--intent <text>", "Describe the purpose of this invocation")
    .option("--output <paths...>", "Override the workspace-relative output files")
    .action((target, task, options) =>
      executePlain(
        (workflows.taskPlan ?? taskPlanWorkflow)(rootDir(), target, task, {
          input: options.input,
          intent: options.intent,
          outputs: options.output,
        }),
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
                `Action: ${value.executionPlan.task.name}\nIntent: ${value.executionPlan.task.intent}\nTarget: ${value.executionPlan.target.name}\n${value.report}`,
              ),
        (value) => value.error,
      ),
    );
  program
    .command("run <target> <action>")
    .description("Run a declared command in an environment; no embedded agent")
    .option("--input <json>", "Merge JSON input into the action defaults", parseActionInput)
    .option("--intent <text>", "Describe the purpose of this invocation")
    .option("--output <paths...>", "Override the workspace-relative output files")
    .option("--json", "Print the run result as JSON")
    .option("--stream", "Stream the persisted event log as JSON Lines")
    .action((target, task, options) => {
      if (options.stream && (!program.opts().events || options.json)) {
        throw new InvalidArgumentError(
          "--stream requires event capture and cannot be combined with --json",
        );
      }
      return execute(
        "run",
        (workflows.runTask ?? runTaskWorkflow)(rootDir(), target, task, {
          input: options.input,
          intent: options.intent,
          outputs: options.output,
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const store = yield* EventStore;
              if (options.json)
                console.log(
                  JSON.stringify(
                    {
                      runId: store.runId,
                      eventLogPath: store.path,
                      exitCode: "exitCode" in error ? (error.exitCode ?? 1) : 1,
                      error: error.message,
                      artifacts: "artifacts" in error ? (error.artifacts ?? []) : [],
                      cleanupFailed: "cleanupFailed" in error ? error.cleanupFailed : undefined,
                    },
                    null,
                    2,
                  ),
                );
              return yield* Effect.fail(error);
            }),
          ),
          Effect.provideService(CommandOutput, {
            progressToStderr: Boolean(options.json || options.stream),
          }),
        ),
        target,
        (result) => {
          if (options.stream) return;
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(`Action "${task}" completed with exit code ${result.exitCode}`);
          console.log(`Run record: ${result.run.runId}`);
          for (const artifact of result.artifacts ?? [])
            console.log(
              `  Artifact: ${artifact.path} (${artifact.sizeBytes} bytes) -> ${artifact.localPath}`,
            );
        },
        options.stream,
      );
    });
  program
    .command("events")
    .description("Show captured structured events for the current project")
    .option("--run <runId>", "Filter to a specific run")
    .option("--json", "Return a cursor-based event page for one run")
    .option("--after <sequence>", "Read events after this sequence number", (value) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0)
        throw new InvalidArgumentError("--after must be a non-negative integer");
      return number;
    })
    .option("--limit <n>", `Maximum events to show (1-${MAX_EVENT_QUERY_LIMIT})`, parseEventLimit)
    .action((options) => {
      if (options.json || options.after !== undefined) {
        if (!options.run) throw new InvalidArgumentError("Cursor queries require --run <runId>");
        return executePlain(
          eventPageWorkflow(rootDir(), options.run, options.after ?? 0, options.limit),
          (page) => console.log(JSON.stringify(page, null, 2)),
        );
      }
      return executePlain(
        (workflows.events ?? eventsWorkflow)(rootDir(), eventQuery(options.run, options.limit)),
        (lines) => {
          for (const line of lines) console.log(line);
        },
      );
    });
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
