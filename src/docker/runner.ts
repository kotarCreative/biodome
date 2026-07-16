import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { NodeRuntime } from "../core/runtime-node.js"
import type { SandboxRuntime } from "../core/runtime.js"
import { RuntimeError } from "../core/errors.js"

const COMPOSE_FILE = ".sandbox/docker-compose.yaml"

function platformErrorMessage(error: PlatformError): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error)
}

const execDocker = Effect.fnUntraced(
  function*(options: { project: string; args: string[]; cwd?: string }) {
    const handle = yield* ChildProcess.make("docker", options.args, {
      cwd: options.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = (yield* handle.exitCode) as number
    if (exitCode !== 0) {
      return yield* new RuntimeError({
        message: `exited with code ${exitCode}`,
        command: `docker ${options.args.join(" ")}`,
      })
    }
  },
  (effect, options) =>
    effect.pipe(
      Effect.provide(NodeRuntime),
      Effect.scoped,
      Effect.catch((error) =>
        Effect.fail(
          error instanceof RuntimeError
            ? error
            : new RuntimeError({
                message: platformErrorMessage(error as PlatformError),
                command: `docker ${options.args.join(" ")}`,
              })
        )
      )
    )
)

export class DockerRuntime implements SandboxRuntime {
  project: string

  constructor(project: string) {
    this.project = project
  }

  ensureAvailable = Effect.fnUntraced(
    function*(this: DockerRuntime) {
      const handle = yield* ChildProcess.make("docker", ["version"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      const exitCode = (yield* handle.exitCode) as number
      if (exitCode !== 0) {
        return yield* new RuntimeError({
          message:
            "Docker is not available or the daemon is not running. " +
            "Make sure Docker is installed and started, or run a command that does not need Docker (e.g. 'sandbox config validate').",
        })
      }
    },
    (effect) =>
      effect.pipe(
        Effect.provide(NodeRuntime),
        Effect.scoped,
        Effect.catch((error) =>
          Effect.fail(
            error instanceof RuntimeError
              ? error
              : new RuntimeError({
                  message: platformErrorMessage(error as PlatformError),
                })
          )
        )
      )
  )

  build(rootDir: string): Effect.Effect<void, RuntimeError, never> {
    return execDocker({
      project: this.project,
      args: ["compose", "-f", COMPOSE_FILE, "-p", this.project, "build"],
      cwd: rootDir,
    })
  }

  start(rootDir: string, build = false): Effect.Effect<void, RuntimeError, never> {
    const args = ["compose", "-f", COMPOSE_FILE, "-p", this.project, "up", "-d"]
    if (build) {
      args.push("--build")
    }
    return execDocker({ project: this.project, args, cwd: rootDir })
  }

  stop(rootDir?: string): Effect.Effect<void, RuntimeError, never> {
    return execDocker({
      project: this.project,
      args: ["compose", "-f", COMPOSE_FILE, "-p", this.project, "down"],
      cwd: rootDir,
    })
  }

  exec(command: string[]): Effect.Effect<void, RuntimeError, never> {
    return execDocker({
      project: this.project,
      args: ["exec", `${this.project}-dev`, ...command],
    })
  }

  status(): Effect.Effect<void, RuntimeError, never> {
    return execDocker({
      project: this.project,
      args: ["compose", "-f", COMPOSE_FILE, "-p", this.project, "ps"],
    })
  }

  logs(processName?: string): Effect.Effect<void, RuntimeError, never> {
    const args = processName
      ? ["exec", `${this.project}-dev`, "tail", "-f", `/tmp/${processName}.log`]
      : ["exec", `${this.project}-dev`, "tail", "-f", "/tmp/supervisord.log"]
    return execDocker({ project: this.project, args })
  }

  restart(processName: string): Effect.Effect<void, RuntimeError, never> {
    return execDocker({
      project: this.project,
      args: [
        "exec",
        `${this.project}-dev`,
        "supervisorctl",
        "-c",
        "/workspace/.sandbox/supervisord.conf",
        "restart",
        processName,
      ],
    })
  }
}
