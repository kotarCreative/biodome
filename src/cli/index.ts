import { Command } from "commander"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { buildPlanEffect, validateConfigEffect, validateFeaturesEffect } from "../builder/index.js"
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
import type { SandboxRuntime } from "../core/runtime.js"
import { PlanError } from "../core/errors.js"
import { NodeRuntime } from "../core/runtime-node.js"
import { runHooks, runSafe } from "./helpers.js"

const SANDBOX_DIR = ".sandbox"

function ensureSandboxDir(rootDir: string): void {
  mkdirSync(join(rootDir, SANDBOX_DIR), { recursive: true })
}

function writeGeneratedFiles(rootDir: string, plan: Plan): void {
  ensureSandboxDir(rootDir)
  writeFileSync(join(rootDir, SANDBOX_DIR, "Dockerfile"), generateDockerfile(plan))

  const supervisord = generateSupervisordConf(plan)
  if (supervisord) {
    writeFileSync(join(rootDir, SANDBOX_DIR, "supervisord.conf"), supervisord)
  }

  writeFileSync(join(rootDir, SANDBOX_DIR, "docker-compose.yaml"), generateCompose(plan))

  const healthcheckDir = join(rootDir, SANDBOX_DIR, "healthchecks")
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
}

function createRuntime(project: string): SandboxRuntime {
  return new DockerRuntime(project)
}

function withNodeRuntime<E>(
  program: Effect.Effect<void, E, ChildProcessSpawner.ChildProcessSpawner>
): Effect.Effect<void, E, never> {
  return program.pipe(Effect.provide(NodeRuntime)) as Effect.Effect<void, E, never>
}

const program = new Command()
program.name("sandbox").description("Development environment manager").version("0.1.0")

program
  .command("init")
  .description("Initialize a sandbox/ directory")
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const sandboxDir = join(rootDir, "sandbox")
      const projectName = rootDir.split("/").pop() || "project"

      if (existsSync(sandboxDir)) {
        return yield* new PlanError({ message: "Sandbox directory already exists" })
      }

      yield* Effect.try({
        try: () => {
          mkdirSync(sandboxDir, { recursive: true })
          writeFileSync(
            join(sandboxDir, "config.json"),
            JSON.stringify({ project: { name: projectName } }, null, 2) + "\n"
          )
          writeFileSync(
            join(sandboxDir, "services.mjs"),
            "export default function services(ctx) {\n  // Define backing services here\n}\n"
          )
          mkdirSync(join(sandboxDir, "features"), { recursive: true })
          writeFileSync(join(sandboxDir, "features", ".gitkeep"), "")
        },
        catch: (error) =>
          new PlanError({
            message: error instanceof Error ? error.message : String(error),
          }),
      })

      console.log(`Initialized sandbox for ${projectName}`)
    })

    runSafe(cliProgram)
  })

program
  .command("build")
  .description("Prepare the development environment")
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      writeGeneratedFiles(rootDir, plan)
      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      yield* runHooks(plan, "build.pre", runtime, rootDir)
      yield* runtime.build(rootDir)
      yield* runHooks(plan, "build.post", runtime, rootDir)
      console.log(`Environment ready for ${plan.project}`)
    }).pipe(Effect.scoped)

    runSafe(withNodeRuntime(cliProgram))
  })

program
  .command("up")
  .description("Start the development environment")
  .option("--build", "Rebuild the environment before starting")
  .option("--wait", "Block until Ctrl+C is pressed")
  .action((options) => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      writeGeneratedFiles(rootDir, plan)

      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      yield* runHooks(plan, "start.pre", runtime, rootDir)
      yield* runtime.start(rootDir, options.build)
      yield* runHooks(plan, "start.post", runtime, rootDir)

      console.log(`Workspace ${plan.project} is running`)

      if (options.wait) {
        console.log("Press Ctrl+C to stop")
        yield* Effect.callback<void, never, never>((resume) => {
          process.on("SIGINT", () => {
            console.log("\nStopping...")
            resume(Effect.void)
          })
        })
        yield* runtime.stop(rootDir)
      }
    }).pipe(Effect.scoped)

    runSafe(withNodeRuntime(cliProgram))
  })

program
  .command("down")
  .description("Stop the development environment")
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      yield* runHooks(plan, "stop.pre", runtime, rootDir)
      yield* runtime.stop(rootDir)
      yield* runHooks(plan, "stop.post", runtime, rootDir)
      console.log("Stopped")
    }).pipe(Effect.scoped)

    runSafe(withNodeRuntime(cliProgram))
  })

program
  .command("exec <command...>")
  .description("Run a command in the dev container")
  .allowUnknownOption()
  .action((cmd: string[]) => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
      const runtime = createRuntime(plan.project)
      yield* runtime.ensureAvailable()
      yield* runHooks(plan, "exec.pre", runtime, rootDir)
      yield* runtime.exec(cmd)
      yield* runHooks(plan, "exec.post", runtime, rootDir)
    }).pipe(Effect.scoped)

    runSafe(withNodeRuntime(cliProgram))
  })

program
  .command("info")
  .description("Show project summary and connection info")
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
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const config = yield* validateConfigEffect(rootDir)
      const runtime = createRuntime(config.project.name)
      yield* runtime.ensureAvailable()
      yield* runtime.logs(processName)
    }).pipe(Effect.scoped)

    runSafe(withNodeRuntime(cliProgram))
  })

program
  .command("ps")
  .description("Show running containers for the project")
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const config = yield* validateConfigEffect(rootDir)
      const runtime = createRuntime(config.project.name)
      yield* runtime.ensureAvailable()
      yield* runtime.status()
    }).pipe(Effect.scoped)

    runSafe(withNodeRuntime(cliProgram))
  })

program
  .command("restart [process]")
  .description("Restart a managed process or all daemon processes")
  .action((processName?: string) => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir)
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

    runSafe(withNodeRuntime(cliProgram))
  })

const configCmd = program.command("config").description("Manage sandbox configuration")

configCmd
  .command("validate")
  .description("Validate sandbox/ configuration and feature module exports without building")
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      yield* validateFeaturesEffect(rootDir)
      console.log("Configuration is valid")
    })

    runSafe(cliProgram)
  })

const generateCmd = program.command("generate").description("Generate project files")

generateCmd
  .command("agents.md")
  .description("Generate AGENTS.md for AI context")
  .action(() => {
    const cliProgram = Effect.gen(function* () {
      const rootDir = process.cwd()
      const plan = yield* buildPlanEffect(rootDir, { dryRun: true })
      writeFileSync(join(rootDir, "AGENTS.md"), formatAgentsMd(plan))
      console.log("Generated AGENTS.md")
    })

    runSafe(cliProgram)
  })

program.parse()
