import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { existsSync } from "node:fs"
import { join } from "node:path"
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

export interface StarterLanguage {
  name: string
  options: { version: string }
}

export function detectStarterLanguages(rootDir: string): StarterLanguage[] {
  const languages: StarterLanguage[] = []

  const hasNode =
    existsSync(join(rootDir, "package.json")) ||
    existsSync(join(rootDir, "package-lock.json")) ||
    existsSync(join(rootDir, "pnpm-lock.yaml")) ||
    existsSync(join(rootDir, "yarn.lock")) ||
    existsSync(join(rootDir, "bun.lockb")) ||
    existsSync(join(rootDir, "bun.lock"))
  if (hasNode) {
    languages.push({ name: "node", options: { version: "20" } })
  }

  const hasPython =
    existsSync(join(rootDir, "requirements.txt")) ||
    existsSync(join(rootDir, "pyproject.toml")) ||
    existsSync(join(rootDir, "poetry.lock"))
  if (hasPython) {
    languages.push({ name: "python", options: { version: "3.12" } })
  }

  if (existsSync(join(rootDir, "go.mod"))) {
    languages.push({ name: "go", options: { version: "1.22" } })
  }

  const hasRust =
    existsSync(join(rootDir, "Cargo.toml")) ||
    existsSync(join(rootDir, "Cargo.lock"))
  if (hasRust) {
    languages.push({ name: "rust", options: { version: "1.75" } })
  }

  const hasJava =
    existsSync(join(rootDir, "pom.xml")) ||
    existsSync(join(rootDir, "build.gradle")) ||
    existsSync(join(rootDir, "build.gradle.kts"))
  if (hasJava) {
    languages.push({ name: "java", options: { version: "21" } })
  }

  return languages
}

export function generateStarterFeature(languages: StarterLanguage[]): string {
  if (languages.length === 0) {
    return "export default function autoDetect(_ctx) {\n  // No languages detected in the project root\n}\n"
  }

  const lines = languages.map(
    (lang) => `  ctx.addLanguage("${lang.name}", ${JSON.stringify(lang.options)})`
  )
  return `export default function autoDetect(ctx) {\n${lines.join("\n")}\n}\n`
}
