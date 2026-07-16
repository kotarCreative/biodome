import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { validateConfigEffect } from "../builder/index.js"
import { Plan } from "../core/plan.js"
import type { SandboxRuntime } from "../core/runtime.js"
import {
  RuntimeError,
  PlanError,
  SandboxError,
  sandboxErrorMessage,
  isSandboxError,
} from "../core/errors.js"

const HOST_HOOK_POINTS = new Set([
  "build.pre",
  "build.post",
  "start.pre",
  "stop.post",
])

function platformErrorMessage(error: PlatformError): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error)
}

function isKnownSandboxError(error: unknown): error is RuntimeError | PlanError {
  return error instanceof RuntimeError || error instanceof PlanError
}

export function resolveProjectName(rootDir: string): string {
  return Effect.runSync(validateConfigEffect(rootDir)).project.name
}

export function runSafe(
  program: Effect.Effect<void, SandboxError, never>
): Promise<void> {
  return Effect.runPromise(program).catch((error) => {
    const message = isSandboxError(error)
      ? sandboxErrorMessage(error)
      : error instanceof Error
        ? error.message
        : String(error)
    console.error(`Error: ${message}`)
    process.exit(1)
  })
}

export const runHooks = Effect.fnUntraced(
  function*(
    plan: Plan,
    point: string,
    runner: SandboxRuntime,
    rootDir: string
  ) {
    const hooks = plan.runtime.processes.filter(
      (p) => p.mode === "oneshot" && p.startOn === point
    )
    if (hooks.length === 0) return

    for (const hook of hooks) {
      console.log(`[hook] ${hook.name} (${point})`)
      if (HOST_HOOK_POINTS.has(point)) {
        const [cmd, ...args] = hook.command
        const handle = yield* ChildProcess.make(cmd, args, {
          cwd: rootDir,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        })
        const exitCode = (yield* handle.exitCode) as number
        if (exitCode !== 0) {
          return yield* new PlanError({
            message: `Host hook ${hook.name} failed with exit code ${exitCode}`,
          })
        }
      } else {
        yield* runner.exec(hook.command)
      }
    }
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.catch((error) => {
        if (isKnownSandboxError(error)) {
          return Effect.fail(error)
        }
        return Effect.fail(
          new PlanError({ message: platformErrorMessage(error as PlatformError) })
        )
      })
    )
)
