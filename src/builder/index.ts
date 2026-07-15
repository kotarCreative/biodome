import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import { SandboxContext } from "../core/context.js"
import { Plan, Port, ConfigSchema } from "../core/plan.js"
import { ConfigError, FeatureError, PlanError, SandboxError, ValidationError } from "../core/errors.js"

const SANDBOX_DIR = "sandbox"

export interface BuildPlanOptions {
  dryRun?: boolean
}

export interface Config {
  project: {
    name: string
  }
}

export const buildPlanEffect = Effect.fnUntraced(function*(
  rootDir: string,
  options: BuildPlanOptions = {}
) {
  const config = yield* readConfig(rootDir)
  const ctx = new SandboxContext(rootDir, config.project.name, options.dryRun)

  yield* loadServices(rootDir, ctx)
  yield* loadFeatures(rootDir, ctx)

  yield* validatePlan(ctx.plan)

  return ctx.plan
})

export async function buildPlan(rootDir: string, options: BuildPlanOptions = {}): Promise<Plan> {
  return Effect.runPromise(buildPlanEffect(rootDir, options))
}

export const validateConfigEffect = Effect.fnUntraced(function*(rootDir: string) {
  return yield* readConfig(rootDir)
})

export function validateConfig(rootDir: string): Config {
  return Effect.runSync(readConfig(rootDir))
}

const readConfig = Effect.fnUntraced(function*(rootDir: string) {
  const path = join(rootDir, SANDBOX_DIR, "config.json")
  const exists = yield* Effect.sync(() => existsSync(path))
  if (!exists) {
    return yield* new ConfigError({ message: "Missing sandbox config file", path })
  }

  const raw = yield* Effect.try({
    try: () => JSON.parse(readFileSync(path, "utf-8")),
    catch: (error) =>
      new ConfigError({
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        path,
      }),
  })

  return yield* Schema.decodeUnknownEffect(ConfigSchema)(raw).pipe(
    Effect.mapError(
      (issue) =>
        new ConfigError({
          message: `Invalid config: ${formatSchemaIssue(issue)}`,
          path,
        })
    )
  )
})

function formatSchemaIssue(issue: unknown): string {
  // Best-effort formatting of a SchemaError.
  if (issue && typeof issue === "object" && "toString" in issue) {
    return String(issue)
  }
  return String(issue)
}

function validatePlan(plan: Plan): Effect.Effect<void, SandboxError, never> {
  return Effect.try({
    try: () => {
      const seen = new Map<number, string>()

      function registerPort(port: Port, label: string): void {
        if (seen.has(port.host)) {
          throw new ValidationError({
            message: `Host port ${port.host} is used by both ${seen.get(port.host)} and ${label}`,
          })
        }
        seen.set(port.host, label)
      }

      for (const proc of plan.runtime.processes) {
        for (const port of proc.ports) {
          registerPort(port, `process "${proc.name}"`)
        }
      }

      for (const svc of plan.runtime.services) {
        for (const port of svc.ports) {
          registerPort(port, `service "${svc.name}"`)
        }
      }
    },
    catch: (error) =>
      error instanceof ValidationError ? error : new PlanError({ message: String(error) }),
  })
}

const loadServices = Effect.fnUntraced(function*(rootDir: string, ctx: SandboxContext) {
  for (const name of ["services.mjs", "services.js"]) {
    const path = join(rootDir, SANDBOX_DIR, name)
    const exists = yield* Effect.sync(() => existsSync(path))
    if (exists) {
      yield* executeFeatureModule(path, ctx)
      return
    }
  }
})

const loadFeatures = Effect.fnUntraced(function*(rootDir: string, ctx: SandboxContext) {
  const featuresDir = join(rootDir, SANDBOX_DIR, "features")
  const exists = yield* Effect.sync(() => existsSync(featuresDir))
  if (!exists) {
    return
  }

  const files = yield* Effect.sync(() =>
    readdirSync(featuresDir)
      .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
      .sort()
  )

  for (const file of files) {
    const path = join(featuresDir, file)
    yield* executeFeatureModule(path, ctx)
  }
})

const executeFeatureModule = Effect.fnUntraced(function*(path: string, ctx: SandboxContext) {
  const url = pathToFileURL(path).href
  const mod = (yield* Effect.tryPromise<unknown, FeatureError>({
    try: () => import(url),
    catch: (error) =>
      new FeatureError({
        message: error instanceof Error ? error.message : String(error),
        path,
      }),
  })) as { default?: (ctx: SandboxContext) => void | Promise<void> }

  if (typeof mod.default !== "function") {
    return yield* new FeatureError({
      message: "Feature module must export a default function that accepts the sandbox context",
      path,
    })
  }

  yield* Effect.tryPromise<void, FeatureError>({
    try: () => Promise.resolve(mod.default!(ctx)),
    catch: (error) =>
      error instanceof FeatureError
        ? error
        : new FeatureError({
            message: error instanceof Error ? error.message : String(error),
            path,
          }),
  })
})
