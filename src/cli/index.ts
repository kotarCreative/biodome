import { Command } from "commander"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import {
  buildPlanEffect,
  validateConfigEffect,
  validateFeaturesEffect,
  validatePlan,
} from "../builder/index.js"
import {
  generateDockerfile,
  generateSupervisordConf,
  generateCompose,
  generateDockerignore,
  generateHealthcheckScripts,
} from "../docker/generator.js"
import { DockerRuntime } from "../docker/runner.js"
import { formatInfo, formatAgentsMd } from "../core/info.js"
import { Plan } from "../core/plan.js"
import { generatePlanJson } from "../mcp/generator.js"
import type { SandboxRuntime } from "../core/runtime.js"
import { PlanError, SandboxError } from "../core/errors.js"
import { NodeRuntime } from "../core/runtime-node.js"
import { BiodomeTelemetry } from "../core/telemetry.js"
import {
  detectStarterLanguages,
  generateStarterFeature,
  runHooks,
  runSafe,
} from "./helpers.js"
import { EventStore, FileEventStoreLive, NoOpEventStoreLive, SandboxEvent, eventLogPath, formatEvent } from "../core/events.js"

const CONFIG_DIR = ".biodome"
const BUILD_DIR = ".biodome-build"

const __dirname = dirname(fileURLToPath(import.meta.url))

function mcpServerSourcePath(): string {
  // When running from dist/cli/index.js, the built MCP server is at dist/mcp/server.js.
  return join(__dirname, "..", "mcp", "server.js")
}

function ensureBuildDir(rootDir: string): void {
  mkdirSync(join(rootDir, BUILD_DIR), { recursive: true })
}

function ensureGitignore(rootDir: string): void {
  const gitignorePath = join(rootDir, ".gitignore")
  const entry = ".biodome-build/"
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `# biodome build output\n${entry}\n`)
    return
  }
  const content = readFileSync(gitignorePath, "utf-8")
  if (!content.split("\n").some((line) => line.trim() === entry)) {
    writeFileSync(gitignorePath, content.trimEnd() + `\n# biodome build output\n${entry}\n`)
  }
}

function writeGeneratedFiles(rootDir: string, plan: Plan): string[] {
  ensureBuildDir(rootDir)
  writeFileSync(join(rootDir, BUILD_DIR, "Dockerfile"), generateDockerfile(plan))

  const supervisord = generateSupervisordConf(plan)
  if (supervisord) {
    writeFileSync(join(rootDir, BUILD_DIR, "supervisord.conf"), supervisord)
  }

  writeFileSync(join(rootDir, BUILD_DIR, "docker-compose.yaml"), generateCompose(plan))

  const healthcheckDir = join(rootDir, BUILD_DIR, "healthchecks")
  rmSync(healthcheckDir, { recursive: true, force: true })
  mkdirSync(healthcheckDir, { recursive: true })
  const healthchecks = generateHealthcheckScripts(plan)
  for (const [name, content] of Object.entries(healthchecks)) {
    writeFileSync(join(healthcheckDir, name), content)
  }

  const dockerignorePath = join(rootDir, ".dockerignore")
  if (!existsSync(dockerignorePath)) {
    writeFileSync(dockerignorePath, generateDockerignore())
  }

  ensureGitignore(rootDir)

  if (plan.build.mcpEnabled) {
    writeFileSync(join(rootDir, BUILD_DIR, "plan.json"), generatePlanJson(plan))
    copyFileSync(mcpServerSourcePath(), join(rootDir, BUILD_DIR, "mcp-server.js"))
  }

  return [
    join(rootDir, BUILD_DIR, "Dockerfile"),
    join(rootDir, BUILD_DIR, "docker-compose.yaml"),
    join(rootDir, BUILD_DIR, "supervisord.conf"),
    ...Object.keys(healthchecks).map((name) => join(healthcheckDir, name)),
  ].filter((p) => existsSync(p))
}

function createRuntime(project: string): SandboxRuntime {
  return new DockerRuntime(project)
}

function buildEventStoreLayer(
  rootDir: string,
  enabled: boolean,
  runId: string
): Layer.Layer<EventStore> {
  if (!enabled) {
    return NoOpEventStoreLive(runId)
  }
  return FileEventStoreLive({
    runId,
    path: eventLogPath(rootDir, runId),
  })
}

function buildLayers(
  rootDir: string,
  enabled: boolean,
  runId: string
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner | EventStore, never, never> {
  return Layer.merge(NodeRuntime, buildEventStoreLayer(rootDir, enabled, runId))
}

function withLayers<E>(
  program: Effect.Effect<void, E, ChildProcessSpawner.ChildProcessSpawner | EventStore>,
  rootDir: string,
  enabled: boolean,
  runId: string
): Effect.Effect<void, E, never> {
  return program.pipe(
    Effect.provide(buildLayers(rootDir, enabled, runId)),
    Effect.provide(BiodomeTelemetry)
  ) as Effect.Effect<void, E, never>
}

function wrapRunEvents(
  command: string,
  effect: Effect.Effect<void, SandboxError, EventStore | ChildProcessSpawner.ChildProcessSpawner>
): Effect.Effect<void, SandboxError, EventStore | ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const store = yield* EventStore
    const start = Date.now()
    yield* store.emit("run.started", { command, cwd: process.cwd() })
    const result = yield* effect.pipe(
      Effect.tap(() =>
        store.emit("run.completed", { command, durationMs: Date.now() - start })
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = error instanceof Error ? error.message : String(error)
          yield* store.emit("run.failed", { command, durationMs: Date.now() - start, error: message })
          yield* store.close()
          return yield* Effect.fail(error)
        })
      )
    )
    yield* store.close()
    return result
  })
}

function emitPlanLoaded(plan: Plan): Effect.Effect<void, never, EventStore> {
  return Effect.gen(function* () {
    const store = yield* EventStore
    yield* store.emit("plan.loaded", {
      project: plan.project,
      languages: plan.build.languageRequests.map((l) => l.name),
      services: plan.runtime.services.map((s) => s.name),
      processes: plan.runtime.processes.map((p) => p.name),
    })
  })
}

function emitFilesGenerated(rootDir: string, files: string[]): Effect.Effect<void, never, EventStore> {
  return Effect.gen(function* () {
    const store = yield* EventStore
    yield* store.emit("files.generated", { rootDir, files })
  })
}

function emitConfigValidated(project: string, valid: boolean): Effect.Effect<void, never, EventStore> {
  return Effect.gen(function* () {
    const store = yield* EventStore
    yield* store.emit("config.validated", { project, valid })
  })
}

const program = new Command()
program.name("biodome").description("Self-contained development environment manager").version("0.1.0")
program.option("--no-events", "disable structured event capture")

program
  .command("init")
  .description("Initialize the .biodome/ config directory with language auto-detection")
  .option("--bare", "Skip language auto-detection and create a minimal .biodome")
  .action((options) => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const configDir = join(rootDir, CONFIG_DIR)
      const projectName = rootDir.split("/").pop() || "project"

      if (existsSync(configDir)) {
        return yield* new PlanError({ message: "Config directory .biodome already exists" })
      }

      yield* Effect.try({
        try: () => {
          mkdirSync(configDir, { recursive: true })
          writeFileSync(
            join(configDir, "config.json"),
            JSON.stringify({ project: { name: projectName } }, null, 2) + "\n"
          )
          writeFileSync(
            join(configDir, "services.mjs"),
            "export default function services(ctx) {\n  // Define backing services here\n}\n"
          )
          mkdirSync(join(configDir, "features"), { recursive: true })

          if (options.bare) {
            writeFileSync(join(configDir, "features", ".gitkeep"), "")
          } else {
            const languages = detectStarterLanguages(rootDir)
            writeFileSync(
              join(configDir, "features", "auto-detect.mjs"),
              generateStarterFeature(languages)
            )
          }
        },
        catch: (error) =>
          new PlanError({
            message: error instanceof Error ? error.message : String(error),
          }),
      })

      yield* Effect.logInfo(`Initialized .biodome config for ${projectName}`)
    })

    runSafe(cliProgram)
  })

program
  .command("build")
  .description("Prepare the development environment")
  .action(() => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      yield* emitPlanLoaded(plan)
      const files = writeGeneratedFiles(rootDir, plan)
      yield* emitFilesGenerated(rootDir, files)
      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      yield* runHooks(plan, "build.pre", runtime, rootDir)
      yield* runtime.build(rootDir)
      yield* runHooks(plan, "build.post", runtime, rootDir)
      yield* Effect.logInfo(`Environment ready for ${plan.project}`)
    }).pipe(Effect.scoped)

    const wrapped = wrapRunEvents("build", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

program
  .command("up")
  .description("Start the development environment")
  .option("--build", "Rebuild the environment before starting")
  .option("--wait", "Block until Ctrl+C is pressed")
  .action((options) => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      yield* emitPlanLoaded(plan)
      const files = writeGeneratedFiles(rootDir, plan)
      yield* emitFilesGenerated(rootDir, files)

      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      yield* runHooks(plan, "start.pre", runtime, rootDir)
      yield* runtime.start(rootDir, options.build)
      yield* runHooks(plan, "start.post", runtime, rootDir)

      yield* Effect.logInfo(`Workspace ${plan.project} is running`)

      if (options.wait) {
        yield* Effect.logInfo("Press Ctrl+C to stop")
        yield* Effect.callback<void, never, never>((resume) => {
          process.on("SIGINT", () => {
            resume(Effect.void)
          })
        })
        yield* runtime.stop(rootDir)
      }
    }).pipe(Effect.scoped)

    const wrapped = wrapRunEvents("up", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

program
  .command("down")
  .description("Stop the development environment")
  .action(() => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      yield* emitPlanLoaded(plan)
      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      yield* runHooks(plan, "stop.pre", runtime, rootDir)
      yield* runtime.stop(rootDir)
      yield* runHooks(plan, "stop.post", runtime, rootDir)
      yield* Effect.logInfo("Stopped")
    }).pipe(Effect.scoped)

    const wrapped = wrapRunEvents("down", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

program
  .command("exec <command...>")
  .description("Run a command in the dev container")
  .allowUnknownOption()
  .action((cmd: string[]) => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      yield* emitPlanLoaded(plan)
      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      yield* runHooks(plan, "exec.pre", runtime, rootDir)
      yield* runtime.exec(cmd)
      yield* runHooks(plan, "exec.post", runtime, rootDir)
    }).pipe(Effect.scoped)

    const wrapped = wrapRunEvents("exec", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

program
  .command("info")
  .description("Show project summary: languages, services, endpoints, environment, processes, and connection info")
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir, { dryRun: true })
      console.log(formatInfo(plan))
    })

    runSafe(cliProgram)
  })

program
  .command("logs [process]")
  .description("Tail logs from a managed process")
  .action((processName?: string) => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const config = yield* validateConfigEffect(rootDir)
      const runtime = createRuntime(config.project.name)
      yield* runtime.ensureAvailable()
      yield* runtime.logs(processName)
    }).pipe(Effect.scoped)

    const wrapped = wrapRunEvents("logs", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

program
  .command("ps")
  .description("Show running containers for the project")
  .action(() => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const config = yield* validateConfigEffect(rootDir)
      const runtime = createRuntime(config.project.name)
      yield* runtime.ensureAvailable()
      yield* runtime.status()
    }).pipe(Effect.scoped)

    const wrapped = wrapRunEvents("ps", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

program
  .command("status")
  .description("Report container health and running processes")
  .action(() => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const config = yield* validateConfigEffect(rootDir)
      const runtime = createRuntime(config.project.name)
      yield* runtime.ensureAvailable()
      console.log("Container status")
      yield* runtime.status()
      console.log("\nProcess status")
      yield* runtime.exec([
        "supervisorctl",
        "-c",
        "/workspace/.biodome-build/supervisord.conf",
        "status",
      ])
    }).pipe(Effect.scoped)

    const wrapped = wrapRunEvents("status", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

program
  .command("restart [process]")
  .description("Restart a managed process or all daemon processes")
  .action((processName?: string) => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      yield* emitPlanLoaded(plan)
      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      if (processName) {
        yield* runtime.restart(processName)
      } else {
        for (const proc of plan.runtime.processes.filter((p) => p.mode === "daemon")) {
          yield* runtime.restart(proc.name)
        }
      }
    }).pipe(Effect.scoped)

    const wrapped = wrapRunEvents("restart", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

program
  .command("events")
  .description("Show captured structured events for the current project")
  .option("--run <runId>", "Filter to a specific run")
  .action((options) => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const logsDir = join(rootDir, BUILD_DIR, "logs")
      if (!existsSync(logsDir)) {
        console.log("No events captured yet")
        return
      }

      const files = readdirSync(logsDir).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"))
      if (files.length === 0) {
        console.log("No event logs found")
        return
      }

      const events = files
        .flatMap((file: string) => {
          const text = readFileSync(join(logsDir, file), "utf-8")
          return text
            .split("\n")
            .filter((line: string) => line.trim().length > 0)
            .map((line: string) => JSON.parse(line) as SandboxEvent)
        })
        .filter((event: SandboxEvent) => !options.run || event.runId === options.run)
        .sort((a: SandboxEvent, b: SandboxEvent) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

      for (const event of events) {
        console.log(formatEvent(event))
      }
    })

    runSafe(cliProgram)
  })

const configCmd = program.command("config").description("Manage sandbox configuration")

configCmd
  .command("validate")
  .description("Validate .biodome/ configuration and feature modules without building")
  .action(() => {
    const runId = randomUUID()
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      yield* validateFeaturesEffect(rootDir)
      const plan = yield* buildPlanEffect(rootDir, { dryRun: true })
      yield* validatePlan(plan)
      yield* emitConfigValidated(plan.project, true)
      yield* Effect.logInfo("Configuration is valid")
    })

    const wrapped = wrapRunEvents("config validate", cliProgram)
    runSafe(withLayers(wrapped, process.cwd(), program.opts().events, runId))
  })

const generateCmd = program.command("generate").description("Generate project files")

generateCmd
  .command("agents.md")
  .description("Generate AGENTS.md for AI context (languages, services, endpoints, environment, processes)")
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir, { dryRun: true })
      writeFileSync(join(rootDir, "AGENTS.md"), formatAgentsMd(plan))
      yield* Effect.logInfo("Generated AGENTS.md")
    })

    runSafe(cliProgram)
  })

program.parse()
