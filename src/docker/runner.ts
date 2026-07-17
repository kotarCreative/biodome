import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { execFileSync } from "node:child_process"
import { capabilitiesOf } from "../core/capabilities.js"
import { NodeRuntime } from "../core/runtime-node.js"
import type { SandboxRuntime } from "../core/runtime.js"
import { RuntimeError } from "../core/errors.js"
import { EventStore, type EventData } from "../core/events.js"

const COMPOSE_FILE = ".biodome/docker-compose.yaml"

const DOCKER_CAPABILITIES = capabilitiesOf(
  "lifecycle.build",
  "lifecycle.start",
  "lifecycle.stop",
  "lifecycle.restart",
  "exec.command",
  "logs.stream",
  "status.read",
  "process.signal"
)

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

interface ServiceStatus {
  readonly name: string
  readonly state: string
  readonly health?: string
}

export function parseServiceStatus(raw: unknown): ServiceStatus | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const item = raw as Record<string, unknown>
  const name = typeof item.Service === "string" ? item.Service : undefined
  const state = typeof item.State === "string" ? item.State : undefined
  if (!name || !state) return undefined
  const health = typeof item.Health === "string" ? item.Health : undefined
  return { name, state, health }
}

// Docker Compose >= 2.21.0 emits `ps --format json` as JSON Lines (one object
// per line); older versions emit a single JSON array. Handle both, plus the
// empty-output case (no running services).
export function parseServiceStatusOutput(output: string): readonly ServiceStatus[] {
  const trimmed = output.trim()
  if (trimmed.length === 0) return []

  const records: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown)

  return records
    .map(parseServiceStatus)
    .filter((s): s is ServiceStatus => s !== undefined)
}

function getServiceStatuses(
  project: string,
  cwd?: string
): Effect.Effect<readonly ServiceStatus[], RuntimeError, never> {
  return Effect.try({
    try: () => {
      const output = execFileSync(
        "docker",
        ["compose", "-f", COMPOSE_FILE, "-p", project, "ps", "--format", "json"],
        { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      )
      return parseServiceStatusOutput(output)
    },
    catch: (error) =>
      new RuntimeError({
        message: `Failed to query service status: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })
}

function withTiming<
  A,
  E,
  R,
  StartType extends keyof EventData,
  CompleteType extends keyof EventData,
  FailType extends keyof EventData,
>(options: {
  startType: StartType
  startData: EventData[StartType]
  completeType: CompleteType
  completeData: (durationMs: number) => EventData[CompleteType]
  failType: FailType
  failData: (durationMs: number, error: string) => EventData[FailType]
  effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R | EventStore> {
  return Effect.gen(function* () {
    const store = yield* EventStore
    const start = Date.now()
    yield* store.emit(options.startType, options.startData)
    const result = yield* options.effect.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = error instanceof Error ? error.message : String(error)
          yield* store.emit(options.failType, options.failData(Date.now() - start, message))
          return yield* Effect.fail(error)
        })
      )
    )
    yield* store.emit(options.completeType, options.completeData(Date.now() - start))
    return result
  })
}

export class DockerRuntime implements SandboxRuntime {
  project: string
  readonly capabilities = DOCKER_CAPABILITIES

  constructor(project: string) {
    this.project = project
  }

  ensureAvailable(): Effect.Effect<void, RuntimeError, EventStore> {
    return Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.emit("runtime.ensureAvailable", { backend: "docker" })
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
            "Make sure Docker is installed and started, or run a command that does not need Docker (e.g. 'biodome config validate').",
        })
      }
    }).pipe(
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
  }

  build(rootDir: string): Effect.Effect<void, RuntimeError, EventStore> {
    return withTiming({
      startType: "runtime.build.started",
      startData: { rootDir },
      completeType: "runtime.build.completed",
      completeData: (durationMs) => ({ rootDir, durationMs }),
      failType: "runtime.build.failed",
      failData: (durationMs, error) => ({ rootDir, durationMs, error }),
      effect: execDocker({
        project: this.project,
        args: ["compose", "-f", COMPOSE_FILE, "-p", this.project, "build"],
        cwd: rootDir,
      }),
    })
  }

  start(rootDir: string, build = false): Effect.Effect<void, RuntimeError, EventStore> {
    const project = this.project
    return Effect.gen(function* () {
      const store = yield* EventStore
      const start = Date.now()
      yield* store.emit("runtime.start.started", { rootDir, build })

      const args = ["compose", "-f", COMPOSE_FILE, "-p", project, "up", "-d"]
      if (build) {
        args.push("--build")
      }

      yield* execDocker({ project, args, cwd: rootDir }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = error instanceof Error ? error.message : String(error)
            yield* store.emit("runtime.start.failed", {
              rootDir,
              durationMs: Date.now() - start,
              build,
              error: message,
            })
            return yield* Effect.fail(error)
          })
        )
      )

      const statuses = yield* getServiceStatuses(project, rootDir)
      for (const status of statuses) {
        if (status.state === "running") {
          yield* store.emit("service.start.completed", {
            name: status.name,
            state: status.state,
            health: status.health,
          })
        } else {
          yield* store.emit("service.start.failed", {
            name: status.name,
            error: `service state is ${status.state}`,
          })
        }
      }

      yield* store.emit("runtime.start.completed", {
        rootDir,
        durationMs: Date.now() - start,
        build,
      })
    })
  }

  stop(rootDir?: string): Effect.Effect<void, RuntimeError, EventStore> {
    const project = this.project
    return Effect.gen(function* () {
      const store = yield* EventStore
      const start = Date.now()
      yield* store.emit("runtime.stop.started", { rootDir })

      const beforeStatuses = yield* getServiceStatuses(project, rootDir)
      for (const status of beforeStatuses) {
        yield* store.emit("service.stop.started", { name: status.name })
      }

      yield* execDocker({
        project,
        args: ["compose", "-f", COMPOSE_FILE, "-p", project, "down"],
        cwd: rootDir,
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = error instanceof Error ? error.message : String(error)
            yield* store.emit("runtime.stop.failed", {
              rootDir,
              durationMs: Date.now() - start,
              error: message,
            })
            return yield* Effect.fail(error)
          })
        )
      )

      for (const status of beforeStatuses) {
        yield* store.emit("service.stop.completed", { name: status.name })
      }

      yield* store.emit("runtime.stop.completed", {
        rootDir,
        durationMs: Date.now() - start,
      })
    })
  }

  exec(command: string[]): Effect.Effect<void, RuntimeError, EventStore> {
    return withTiming({
      startType: "runtime.exec.started",
      startData: { command },
      completeType: "runtime.exec.completed",
      completeData: (durationMs) => ({ command, durationMs }),
      failType: "runtime.exec.failed",
      failData: (durationMs, error) => ({ command, durationMs, error }),
      effect: execDocker({
        project: this.project,
        args: ["exec", `${this.project}-dev`, ...command],
      }),
    })
  }

  status(): Effect.Effect<void, RuntimeError, EventStore> {
    const project = this.project
    return Effect.gen(function* () {
      const store = yield* EventStore
      const start = Date.now()
      yield* store.emit("runtime.status.started", {})

      yield* execDocker({
        project,
        args: ["compose", "-f", COMPOSE_FILE, "-p", project, "ps"],
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = error instanceof Error ? error.message : String(error)
            yield* store.emit("runtime.status.failed", {
              durationMs: Date.now() - start,
              error: message,
            })
            return yield* Effect.fail(error)
          })
        )
      )

      const statuses = yield* getServiceStatuses(project)
      for (const status of statuses) {
        yield* store.emit("service.health_check", {
          name: status.name,
          status: status.health ?? status.state,
        })
      }

      yield* store.emit("runtime.status.completed", {
        durationMs: Date.now() - start,
      })
    })
  }

  logs(processName?: string): Effect.Effect<void, RuntimeError, EventStore> {
    const project = this.project
    return Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.emit("runtime.logs.started", { processName })
      const args = processName
        ? ["exec", `${project}-dev`, "tail", "-f", `/tmp/${processName}.log`]
        : ["exec", `${project}-dev`, "tail", "-f", "/tmp/supervisord.log"]
      yield* execDocker({ project, args })
      yield* store.emit("runtime.logs.completed", { processName })
    })
  }

  restart(processName: string): Effect.Effect<void, RuntimeError, EventStore> {
    return withTiming({
      startType: "runtime.restart.started",
      startData: { processName },
      completeType: "runtime.restart.completed",
      completeData: (durationMs) => ({ processName, durationMs }),
      failType: "runtime.restart.failed",
      failData: (durationMs, error) => ({ processName, durationMs, error }),
      effect: execDocker({
        project: this.project,
        args: [
          "exec",
          `${this.project}-dev`,
          "supervisorctl",
          "-c",
          "/workspace/.biodome/supervisord.conf",
          "restart",
          processName,
        ],
      }),
    })
  }
}
