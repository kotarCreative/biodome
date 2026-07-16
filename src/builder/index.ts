import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import { SandboxContext } from "../core/context.js"
import { Plan, Port, ConfigSchema } from "../core/plan.js"
import { ConfigError, FeatureError, PlanError, SandboxError, ValidationError } from "../core/errors.js"

const BIODOME_DIR = "biodome"

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

  ctx.finalizeBuildPlan()

  yield* validatePlan(ctx.plan)

  return ctx.plan
})

export async function buildPlan(rootDir: string, options: BuildPlanOptions = {}): Promise<Plan> {
  return Effect.runPromise(buildPlanEffect(rootDir, options))
}

export const validateConfigEffect = Effect.fnUntraced(function*(rootDir: string) {
  return yield* readConfig(rootDir)
})

export const validateFeaturesEffect = Effect.fnUntraced(function*(rootDir: string) {
  const config = yield* readConfig(rootDir)

  // Validate the services module the same way loadServices will resolve it:
  // prefer services.mjs, fall back to services.js, but never both.
  const servicesMjsPath = join(rootDir, BIODOME_DIR, "services.mjs")
  const servicesMjsExists = yield* Effect.sync(() => existsSync(servicesMjsPath))
  if (servicesMjsExists) {
    yield* checkModuleExports(servicesMjsPath)
  } else {
    const servicesJsPath = join(rootDir, BIODOME_DIR, "services.js")
    const servicesJsExists = yield* Effect.sync(() => existsSync(servicesJsPath))
    if (servicesJsExists) {
      yield* checkModuleExports(servicesJsPath)
    }
  }

  const featuresDir = join(rootDir, BIODOME_DIR, "features")
  const featuresDirExists = yield* Effect.sync(() => existsSync(featuresDir))
  if (featuresDirExists) {
    const files = yield* Effect.sync(() =>
      readdirSync(featuresDir)
        .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
        .sort()
    )
    for (const file of files) {
      yield* checkModuleExports(join(featuresDir, file))
    }
  }

  return config
})

const checkModuleExports = Effect.fnUntraced(function*(path: string) {
  const exists = yield* Effect.sync(() => existsSync(path))
  if (!exists) {
    return
  }
  const url = pathToFileURL(path).href
  // Note: ESM import() evaluates top-level module code. This only guarantees
  // the exported default function is not invoked.
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
      message: "Module must export a default function that accepts the biodome context",
      path,
    })
  }
})

export function validateConfig(rootDir: string): Config {
  return Effect.runSync(readConfig(rootDir))
}

export function validateFeatures(rootDir: string): Promise<Config> {
  return Effect.runPromise(validateFeaturesEffect(rootDir))
}

const readConfig = Effect.fnUntraced(function*(rootDir: string) {
  const path = join(rootDir, BIODOME_DIR, "config.json")
  const exists = yield* Effect.sync(() => existsSync(path))
  if (!exists) {
    return yield* new ConfigError({ message: "Missing biodome config file", path })
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

export function validatePlan(plan: Plan): Effect.Effect<void, SandboxError, never> {
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
    const path = join(rootDir, BIODOME_DIR, name)
    const exists = yield* Effect.sync(() => existsSync(path))
    if (exists) {
      yield* executeFeatureModule(path, ctx)
      return
    }
  }
})

const loadFeatures = Effect.fnUntraced(function*(rootDir: string, ctx: SandboxContext) {
  const featuresDir = join(rootDir, BIODOME_DIR, "features")
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
      message: "Feature module must export a default function that accepts the biodome context",
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
