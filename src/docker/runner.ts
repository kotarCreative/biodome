import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { Provider } from "../core/provider.js"
import { DockerError } from "../core/errors.js"

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
      return yield* new DockerError({
        message: `exited with code ${exitCode}`,
        command: `docker ${options.args.join(" ")}`,
      })
    }
  },
  (effect, options) =>
    effect.pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Effect.fail(
          error instanceof DockerError
            ? error
            : new DockerError({
                message: platformErrorMessage(error as PlatformError),
                command: `docker ${options.args.join(" ")}`,
              })
        )
      )
    )
)

export class Runner implements Provider {
  project: string

  constructor(project: string) {
    this.project = project
  }

  build = Effect.fnUntraced(function*(this: Runner, rootDir: string) {
    return yield* execDocker({
      project: this.project,
      args: ["compose", "-f", COMPOSE_FILE, "-p", this.project, "build"],
      cwd: rootDir,
    })
  })

  up = Effect.fnUntraced(function*(this: Runner, rootDir: string, build = false) {
    const args = ["compose", "-f", COMPOSE_FILE, "-p", this.project, "up", "-d"]
    if (build) {
      args.push("--build")
    }
    return yield* execDocker({ project: this.project, args, cwd: rootDir })
  })

  down = Effect.fnUntraced(function*(this: Runner, rootDir?: string) {
    return yield* execDocker({
      project: this.project,
      args: ["compose", "-f", COMPOSE_FILE, "-p", this.project, "down"],
      cwd: rootDir,
    })
  })

  execInDev = Effect.fnUntraced(function*(this: Runner, command: string[]) {
    return yield* execDocker({
      project: this.project,
      args: ["exec", `${this.project}-dev`, ...command],
    })
  })

  ps = Effect.fnUntraced(function*(this: Runner) {
    return yield* execDocker({
      project: this.project,
      args: ["compose", "-f", COMPOSE_FILE, "-p", this.project, "ps"],
    })
  })

  restart = Effect.fnUntraced(function*(this: Runner, processName: string) {
    return yield* execDocker({
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
  })
}

export const assertDockerAvailable = Effect.fnUntraced(
  function*() {
    const handle = yield* ChildProcess.make("docker", ["version"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    const exitCode = (yield* handle.exitCode) as number
    if (exitCode !== 0) {
      return yield* new DockerError({
        message:
          "Docker is not available or the daemon is not running. " +
          "Make sure Docker is installed and started, or run a command that does not need Docker (e.g. 'sandbox config validate').",
      })
    }
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Effect.fail(
          error instanceof DockerError
            ? error
            : new DockerError({
                message: platformErrorMessage(error as PlatformError),
              })
        )
      )
    )
)
