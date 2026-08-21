import { readdirSync, readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { PlanBuilder } from "../core/plan-builder/plan-builder.js";
import { loadAppsEffect } from "../apps/loader.js";
import { Plan, Port, ConfigSchema } from "../core/plan.js";
import { TargetContextImpl } from "../core/target-context.js";
import { TaskContextImpl } from "../core/task-context.js";
import { getDriver } from "../runtime/registry.js";
import { runtimeLayout } from "../runtime/layout.js";
import type { FeatureContext, TargetContext, TaskContext } from "../core/feature.js";
import {
  ConfigError,
  FeatureError,
  PlanError,
  SandboxError,
  ValidationError,
} from "../core/errors.js";

const BIODOME_DIR = ".biodome";

export interface BuildPlanOptions {
  dryRun?: boolean;
}

export interface McpConfig {
  enabled: boolean;
  port?: number;
  token?: { env: string } | string;
  allowExec?: boolean;
  allowProcessControl?: boolean;
  commandTimeoutMs?: number;
  commandStdoutMaxBytes?: number;
  commandStderrMaxBytes?: number;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxListEntries?: number;
  providerConnectTimeoutMs?: number;
  providerRequestTimeoutMs?: number;
  providerCatalogConcurrency?: number;
}

function isEnvTokenReference(token: McpConfig["token"]): token is { env: string } {
  return typeof token === "object" && token !== null && typeof token.env === "string";
}

export interface Config {
  project: {
    name: string;
  };
  mcp?: McpConfig;
}

export const buildPlanEffect = Effect.fnUntraced(function* (
  rootDir: string,
  options: BuildPlanOptions = {},
) {
  const config = yield* readConfig(rootDir);
  const builder = new PlanBuilder(rootDir, config.project.name, options.dryRun);
  const ctx = builder.context;

  if (config.mcp?.enabled) {
    const port = config.mcp.port ?? 3001;
    const mcpToken = config.mcp.token;
    if (!isEnvTokenReference(mcpToken)) {
      return yield* new ConfigError({
        message: 'MCP requires an environment-backed token when enabled ({ env: "VAR" })',
        path: join(rootDir, BIODOME_DIR, "config.json"),
      });
    }
    builder.configureMcp(port, {
      token: mcpToken,
      allowExec: config.mcp.allowExec,
      allowProcessControl: config.mcp.allowProcessControl,
      commandTimeoutMs: config.mcp.commandTimeoutMs,
      commandStdoutMaxBytes: config.mcp.commandStdoutMaxBytes,
      commandStderrMaxBytes: config.mcp.commandStderrMaxBytes,
      maxReadBytes: config.mcp.maxReadBytes,
      maxWriteBytes: config.mcp.maxWriteBytes,
      maxListEntries: config.mcp.maxListEntries,
      providerConnectTimeoutMs: config.mcp.providerConnectTimeoutMs,
      providerRequestTimeoutMs: config.mcp.providerRequestTimeoutMs,
      providerCatalogConcurrency: config.mcp.providerCatalogConcurrency,
    });
  }

  yield* loadServices(rootDir, ctx);
  yield* loadAppsEffect(rootDir, builder);
  yield* loadFeatures(rootDir, ctx);

  builder.finalize();

  const plan = builder.getPlan();
  yield* validatePlan(plan);

  return plan;
});

export async function buildPlan(rootDir: string, options: BuildPlanOptions = {}): Promise<Plan> {
  return Effect.runPromise(buildPlanEffect(rootDir, options));
}

export const validateConfigEffect = Effect.fnUntraced(function* (rootDir: string) {
  return yield* readConfig(rootDir);
});

export const validateFeaturesEffect = Effect.fnUntraced(function* (rootDir: string) {
  const config = yield* readConfig(rootDir);

  // Validate the services module the same way loadServices will resolve it:
  // prefer services.mjs, fall back to services.js, but never both.
  const servicesMjsPath = join(rootDir, BIODOME_DIR, "services.mjs");
  const servicesMjsExists = yield* Effect.sync(() => existsSync(servicesMjsPath));
  if (servicesMjsExists) {
    yield* checkModuleExports(servicesMjsPath);
  } else {
    const servicesJsPath = join(rootDir, BIODOME_DIR, "services.js");
    const servicesJsExists = yield* Effect.sync(() => existsSync(servicesJsPath));
    if (servicesJsExists) {
      yield* checkModuleExports(servicesJsPath);
    }
  }

  const featuresDir = join(rootDir, BIODOME_DIR, "features");
  const featuresDirExists = yield* Effect.sync(() => existsSync(featuresDir));
  if (featuresDirExists) {
    const files = yield* Effect.sync(() =>
      readdirSync(featuresDir)
        .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
        .sort(),
    );
    for (const file of files) {
      yield* checkModuleExports(join(featuresDir, file));
    }
  }

  return config;
});

const checkModuleExports = Effect.fnUntraced(function* (path: string) {
  const exists = yield* Effect.sync(() => existsSync(path));
  if (!exists) {
    return;
  }
  const url = pathToFileURL(path).href;
  // Note: ESM import() evaluates top-level module code. This only guarantees
  // the exported default function is not invoked.
  const mod = (yield* Effect.tryPromise<unknown, FeatureError>({
    try: () => import(url),
    catch: (error) =>
      new FeatureError({
        message: error instanceof Error ? error.message : String(error),
        path,
      }),
  })) as { default?: (ctx: FeatureContext) => void | Promise<void> };

  if (typeof mod.default !== "function") {
    return yield* new FeatureError({
      message: "Module must export a default function that accepts the biodome context",
      path,
    });
  }
});

export function validateConfig(rootDir: string): Config {
  return Effect.runSync(readConfig(rootDir));
}

export function validateFeatures(rootDir: string): Promise<Config> {
  return Effect.runPromise(validateFeaturesEffect(rootDir));
}

const readConfig = Effect.fnUntraced(function* (rootDir: string) {
  const path = join(rootDir, BIODOME_DIR, "config.json");
  const exists = yield* Effect.sync(() => existsSync(path));
  if (!exists) {
    return yield* new ConfigError({ message: "Missing biodome config file", path });
  }

  const raw = yield* Effect.try({
    try: () => JSON.parse(readFileSync(path, "utf-8")),
    catch: (error) =>
      new ConfigError({
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        path,
      }),
  });

  return yield* Schema.decodeUnknownEffect(ConfigSchema)(raw).pipe(
    Effect.mapError(
      (issue) =>
        new ConfigError({
          message: `Invalid config: ${formatSchemaIssue(issue)}`,
          path,
        }),
    ),
  );
});

function formatSchemaIssue(issue: unknown): string {
  return String(issue);
}

export function validatePlan(plan: Plan): Effect.Effect<void, SandboxError, never> {
  return Effect.try({
    try: () => {
      const seen = new Map<number, string>();

      function registerPort(port: Port, label: string): void {
        if (seen.has(port.host)) {
          throw new ValidationError({
            message: `Host port ${port.host} is used by both ${seen.get(port.host)} and ${label}`,
          });
        }
        seen.set(port.host, label);
      }

      for (const proc of plan.runtime.processes) {
        for (const port of proc.ports) {
          registerPort(port, `process "${proc.name}"`);
        }
      }

      for (const svc of plan.runtime.services) {
        for (const port of svc.ports) {
          registerPort(port, `service "${svc.name}"`);
        }
      }
    },
    catch: (error) =>
      error instanceof ValidationError ? error : new PlanError({ message: String(error) }),
  });
}

const loadServices = Effect.fnUntraced(function* (rootDir: string, ctx: FeatureContext) {
  for (const name of ["services.mjs", "services.js"]) {
    const path = join(rootDir, BIODOME_DIR, name);
    const exists = yield* Effect.sync(() => existsSync(path));
    if (exists) {
      yield* executeFeatureModule(path, ctx);
      return;
    }
  }
});

const loadFeatures = Effect.fnUntraced(function* (rootDir: string, ctx: FeatureContext) {
  const featuresDir = join(rootDir, BIODOME_DIR, "features");
  const exists = yield* Effect.sync(() => existsSync(featuresDir));
  if (!exists) {
    return;
  }

  const files = yield* Effect.sync(() =>
    readdirSync(featuresDir)
      .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
      .sort(),
  );

  for (const file of files) {
    const path = join(featuresDir, file);
    yield* executeFeatureModule(path, ctx);
  }
});

const executeFeatureModule = Effect.fnUntraced(function* (path: string, ctx: FeatureContext) {
  const url = pathToFileURL(path).href;
  const mod = (yield* Effect.tryPromise<unknown, FeatureError>({
    try: () => import(url),
    catch: (error) =>
      new FeatureError({
        message: error instanceof Error ? error.message : String(error),
        path,
      }),
  })) as { default?: (ctx: FeatureContext) => void | Promise<void> };

  if (typeof mod.default !== "function") {
    return yield* new FeatureError({
      message: "Feature module must export a default function that accepts the biodome context",
      path,
    });
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
  });
});

// --- Target and task module loading ---

const BIODOME_TARGETS_DIR = join(BIODOME_DIR, "targets");
const BIODOME_TASKS_DIR = join(BIODOME_DIR, "tasks");

const MODULE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Shared validation for target/task module names so a hostile name can never
// escape its module directory via resolveModulePath + import().
function validateModuleName(name: string, kind: "target" | "task"): void {
  if (!name || typeof name !== "string") {
    throw new Error(`Invalid ${kind} name: ${JSON.stringify(name)} (must be a non-empty string)`);
  }
  if (!MODULE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${kind} name: "${name}". Must match ${MODULE_NAME_PATTERN.source}`);
  }
  if (name === "." || name === "..") {
    throw new Error(`Invalid ${kind} name: "${name}"`);
  }
  if (name.length > 64) {
    throw new Error(`${kind} name too long (${name.length} chars, max 64)`);
  }
}

function isPathWithin(baseDir: string, candidate: string): boolean {
  const pathFromBase = relative(baseDir, candidate);
  return (
    pathFromBase === "" ||
    (!isAbsolute(pathFromBase) && pathFromBase !== ".." && !pathFromBase.startsWith(`..${sep}`))
  );
}

function resolveModulePath(rootDir: string, baseDir: string, name: string): string | null {
  const mjsPath = join(rootDir, baseDir, `${name}.mjs`);
  const jsPath = join(rootDir, baseDir, `${name}.js`);
  const mjsExists = existsSync(mjsPath);
  const jsExists = existsSync(jsPath);
  if (mjsExists && jsExists) return null; // ambiguity
  if (mjsExists) return mjsPath;
  if (jsExists) return jsPath;
  return null;
}

function computeDeploymentId(project: string, targetName: string): string {
  const slug = `${project}-${targetName}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const hash = createHash("sha256").update(slug).digest("hex").slice(0, 8);
  return `${slug.slice(0, 48)}-${hash}`;
}

export const buildTargetPlanEffect = Effect.fnUntraced(function* (
  rootDir: string,
  targetName: string,
  options: BuildPlanOptions = {},
) {
  try {
    validateModuleName(targetName, "target");
  } catch (e) {
    return yield* new ValidationError({ message: (e as Error).message });
  }

  const plan = yield* buildPlanEffect(rootDir, options);

  const targetDir = join(rootDir, BIODOME_TARGETS_DIR);
  const targetPath = resolveModulePath(rootDir, BIODOME_TARGETS_DIR, targetName);

  if (!targetPath) {
    const mjsPath = join(targetDir, `${targetName}.mjs`);
    const jsPath = join(targetDir, `${targetName}.js`);
    const mjsExists = existsSync(mjsPath);
    const jsExists = existsSync(jsPath);
    if (mjsExists && jsExists) {
      return yield* new FeatureError({
        message: `Ambiguous target "${targetName}": both ${targetName}.mjs and ${targetName}.js exist`,
        path: targetDir,
      });
    }
    return yield* new FeatureError({
      message: `Target "${targetName}" not found at ${targetDir}/${targetName}.mjs or .js`,
      path: targetDir,
    });
  }

  if (!isPathWithin(join(rootDir, BIODOME_TARGETS_DIR), targetPath)) {
    return yield* new ValidationError({
      message: `Target "${targetName}" resolves outside ${BIODOME_TARGETS_DIR}`,
    });
  }

  const targetCtx = new TargetContextImpl(targetName);

  const mod = (yield* Effect.tryPromise<unknown, FeatureError>({
    try: () => import(pathToFileURL(targetPath).href),
    catch: (error) =>
      new FeatureError({
        message: error instanceof Error ? error.message : String(error),
        path: targetPath,
      }),
  })) as { default?: (ctx: TargetContext) => void | Promise<void> };

  if (typeof mod.default !== "function") {
    return yield* new FeatureError({
      message: `Target module "${targetName}" must export a default function`,
      path: targetPath,
    });
  }

  yield* Effect.tryPromise<void, FeatureError>({
    try: () => Promise.resolve(mod.default!(targetCtx)),
    catch: (error) =>
      error instanceof FeatureError
        ? error
        : new FeatureError({
            message: error instanceof Error ? error.message : String(error),
            path: targetPath,
          }),
  });

  const rt = targetCtx.getTarget();
  yield* getDriver(rt.driver);
  const deploymentId = computeDeploymentId(plan.project, targetName);

  plan.deployment = {
    target: rt,
    deploymentId,
  };
  applyTargetRuntimeLayout(plan, targetName);

  yield* validatePlan(plan);

  return plan;
});

export async function buildTargetPlan(
  rootDir: string,
  targetName: string,
  options: BuildPlanOptions = {},
): Promise<Plan> {
  return Effect.runPromise(buildTargetPlanEffect(rootDir, targetName, options));
}

function applyTargetRuntimeLayout(plan: Plan, targetName: string): void {
  const baseRoot = runtimeLayout("").container.root;
  const targetRoot = runtimeLayout("", targetName).container.root;
  const rebase = (value: string): string => value.replaceAll(baseRoot, targetRoot);

  for (const process of plan.runtime.processes) {
    process.command = process.command.map(rebase);
    process.environment = Object.fromEntries(
      Object.entries(process.environment).map(([key, value]) => [key, rebase(value)]),
    );
  }
  for (const harness of plan.runtime.agentHarnesses)
    harness.telemetry.path = rebase(harness.telemetry.path);
  for (const harness of plan.runtime.piHarnesses)
    harness.telemetry.path = rebase(harness.telemetry.path);
  for (const harness of plan.runtime.codexHarnesses)
    harness.telemetry.path = rebase(harness.telemetry.path);
  for (const harness of plan.runtime.claudeHarnesses)
    harness.telemetry.path = rebase(harness.telemetry.path);
}

export const buildTaskPlanEffect = Effect.fnUntraced(function* (
  rootDir: string,
  targetName: string,
  taskName: string,
  options: BuildPlanOptions = {},
) {
  try {
    validateModuleName(taskName, "task");
  } catch (e) {
    return yield* new ValidationError({ message: (e as Error).message });
  }

  const plan = yield* buildTargetPlanEffect(rootDir, targetName, options);

  const taskPath = resolveModulePath(rootDir, BIODOME_TASKS_DIR, taskName);
  if (!taskPath) {
    const tasksDir = join(rootDir, BIODOME_TASKS_DIR);
    const mjsPath = join(tasksDir, `${taskName}.mjs`);
    const jsPath = join(tasksDir, `${taskName}.js`);
    const mjsExists = existsSync(mjsPath);
    const jsExists = existsSync(jsPath);
    if (mjsExists && jsExists) {
      return yield* new FeatureError({
        message: `Ambiguous task "${taskName}": both ${taskName}.mjs and ${taskName}.js exist`,
        path: tasksDir,
      });
    }
    return yield* new FeatureError({
      message: `Task "${taskName}" not found at .biodome/tasks/${taskName}.mjs or .js`,
    });
  }

  if (!isPathWithin(join(rootDir, BIODOME_TASKS_DIR), taskPath)) {
    return yield* new ValidationError({
      message: `Task "${taskName}" resolves outside ${BIODOME_TASKS_DIR}`,
    });
  }

  const taskCtx = new TaskContextImpl(taskName);

  const mod = (yield* Effect.tryPromise<unknown, FeatureError>({
    try: () => import(pathToFileURL(taskPath).href),
    catch: (error) =>
      new FeatureError({
        message: error instanceof Error ? error.message : String(error),
        path: taskPath,
      }),
  })) as { default?: (ctx: TaskContext) => void | Promise<void> };

  if (typeof mod.default !== "function") {
    return yield* new FeatureError({
      message: `Task module "${taskName}" must export a default function`,
      path: taskPath,
    });
  }

  yield* Effect.tryPromise<void, FeatureError>({
    try: () => Promise.resolve(mod.default!(taskCtx)),
    catch: (error) =>
      error instanceof FeatureError
        ? error
        : new FeatureError({
            message: error instanceof Error ? error.message : String(error),
            path: taskPath,
          }),
  });

  const taskDecl = taskCtx.getTask();

  const availableServices = new Set(plan.runtime.services.map((service) => service.name));
  const missingServices = (taskDecl.requiredServices ?? []).filter(
    (service) => !availableServices.has(service),
  );
  if (missingServices.length > 0) {
    return yield* new ValidationError({
      message: `Task "${taskName}" requires unknown services: ${missingServices.join(", ")}`,
    });
  }

  const availableProcesses = new Set(plan.runtime.processes.map((process) => process.name));
  const missingProcesses = (taskDecl.requiredProcesses ?? []).filter(
    (process) => !availableProcesses.has(process),
  );
  if (missingProcesses.length > 0) {
    return yield* new ValidationError({
      message: `Task "${taskName}" requires unknown processes: ${missingProcesses.join(", ")}`,
    });
  }

  const allHarnesses = [
    ...plan.runtime.agentHarnesses.map((h) => h.name),
    ...plan.runtime.piHarnesses.map((h) => h.name),
    ...plan.runtime.codexHarnesses.map((h) => h.name),
    ...plan.runtime.claudeHarnesses.map((h) => h.name),
  ];

  if (!allHarnesses.includes(taskDecl.harness)) {
    return yield* new ValidationError({
      message: `Task "${taskName}" references harness "${taskDecl.harness}" which is not declared in any feature. Available harnesses: ${allHarnesses.join(", ") || "(none)"}`,
    });
  }

  plan.deployment = {
    ...plan.deployment!,
    task: taskDecl,
  };

  return plan;
});

export async function buildTaskPlan(
  rootDir: string,
  targetName: string,
  taskName: string,
  options: BuildPlanOptions = {},
): Promise<Plan> {
  return Effect.runPromise(buildTaskPlanEffect(rootDir, targetName, taskName, options));
}
