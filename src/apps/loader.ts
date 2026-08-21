import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { validateTargetName } from "../core/plan.js";
import { PlanBuilder } from "../core/plan-builder/plan-builder.js";
import { FeatureError, ValidationError } from "../core/errors.js";
import { ApplicationBuilderImpl } from "./application-builder.js";
import { sortApplications } from "./graph.js";
import { isAppEndpointReference } from "./references.js";
import { isAppRecipe } from "./recipe.js";
import {
  APP_RECIPE_API_VERSION,
  type AppEndpointReference,
  type AppRecipe,
  type ApplicationBuilder,
} from "./types.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type AppModuleDefault =
  | AppRecipe<unknown>
  | ((app: ApplicationBuilder) => void | Promise<void>);

export interface LoadedAppDeclaration {
  name: string;
  path: string;
  default: AppModuleDefault;
  dependsOn: string[];
}

function appNameFromFile(file: string): string {
  return file.replace(/\.(?:mjs|js)$/, "");
}

function validateAppName(name: string, path: string): void {
  try {
    validateTargetName(name);
  } catch (error) {
    throw new FeatureError({
      message: `Invalid app filename "${name}": ${(error as Error).message}`,
      path,
    });
  }
}

export function appReferencesFromOptions(
  value: unknown,
  found: AppEndpointReference[] = [],
): AppEndpointReference[] {
  if (isAppEndpointReference(value)) {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) appReferencesFromOptions(item, found);
    return found;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new ValidationError({ message: `App recipe options contain unsafe key "${key}"` });
      }
      appReferencesFromOptions((value as Record<string, unknown>)[key], found);
    }
  }
  return found;
}

function validateRecipeOptions(value: unknown, seen = new WeakSet<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return;
  if (typeof value !== "object") {
    throw new ValidationError({
      message: "App recipe options must contain only JSON-safe values and app references",
    });
  }
  if (seen.has(value)) {
    throw new ValidationError({ message: "App recipe options must not contain cycles" });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) validateRecipeOptions(item, seen);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new ValidationError({
        message: "App recipe options must contain only plain objects, arrays, and app references",
      });
    }
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key))
        throw new ValidationError({ message: `App recipe options contain unsafe key "${key}"` });
      validateRecipeOptions((value as Record<string, unknown>)[key], seen);
    }
  } finally {
    seen.delete(value);
  }
}

function normalizeDependencies(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new FeatureError({ message: "App module dependsOn must be an array of app names", path });
  }
  for (const name of value) validateAppName(name, path);
  return [...new Set(value)].sort();
}

/** Discover only immediate, trusted app modules. Imports happen once per plan build. */
export async function discoverApps(rootDir: string): Promise<LoadedAppDeclaration[]> {
  const appsDir = join(rootDir, ".biodome", "apps");
  if (!existsSync(appsDir)) return [];
  const files = readdirSync(appsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")),
    )
    .map((entry) => entry.name)
    .sort();
  const bases = new Map<string, string>();
  for (const file of files) {
    const base = appNameFromFile(file);
    const prior = bases.get(base);
    if (prior) {
      throw new FeatureError({
        message: `Ambiguous app "${base}": both ${prior} and ${file} exist`,
        path: appsDir,
      });
    }
    bases.set(base, file);
  }
  const declarations: LoadedAppDeclaration[] = [];
  for (const file of files) {
    const path = join(appsDir, file);
    const name = appNameFromFile(file);
    validateAppName(name, path);
    let mod: { default?: unknown; dependsOn?: unknown };
    try {
      mod = (await import(pathToFileURL(path).href)) as { default?: unknown; dependsOn?: unknown };
    } catch (error) {
      throw new FeatureError({
        message: error instanceof Error ? error.message : String(error),
        path,
      });
    }
    if (!isAppRecipe(mod.default) && typeof mod.default !== "function") {
      throw new FeatureError({
        message: "App module must default-export an AppRecipe or configuration function",
        path,
      });
    }
    if (isAppRecipe(mod.default)) {
      if (mod.default.apiVersion !== APP_RECIPE_API_VERSION) {
        throw new FeatureError({
          message: `Unsupported app recipe API version for ${mod.default.id}: ${mod.default.apiVersion}; supported version is ${APP_RECIPE_API_VERSION}`,
          path,
        });
      }
      validateRecipeOptions(mod.default.options);
    }
    const explicit = normalizeDependencies(mod.dependsOn, path);
    const inferred = isAppRecipe(mod.default)
      ? appReferencesFromOptions(mod.default.options).map((reference) => reference.app)
      : [];
    declarations.push({
      name,
      path,
      default: mod.default as AppModuleDefault,
      dependsOn: [...new Set([...explicit, ...inferred])].sort(),
    });
  }
  return declarations;
}

export function loadAppsEffect(
  rootDir: string,
  builder: PlanBuilder,
): Effect.Effect<void, FeatureError | ValidationError, never> {
  return Effect.tryPromise<void, FeatureError | ValidationError>({
    try: async () => {
      const declarations = await discoverApps(rootDir);
      const knownApps = new Set(declarations.map((declaration) => declaration.name));
      const order = sortApplications(
        declarations.map(({ name, dependsOn }) => ({ name, dependencies: dependsOn })),
      );
      const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
      await builder.expandApplications(async (context, plan) => {
        for (const name of order) {
          const declaration = byName.get(name);
          if (!declaration) {
            throw new ValidationError({
              message: `Application "${name}" was ordered but not discovered`,
            });
          }
          const recipe = isAppRecipe(declaration.default) ? declaration.default : undefined;
          const app = new ApplicationBuilderImpl(context, plan, {
            name,
            declarationPath: relative(rootDir, declaration.path) || declaration.path,
            recipe: recipe
              ? {
                  id: recipe.id,
                  version: recipe.version,
                  declarationPath: relative(rootDir, declaration.path) || declaration.path,
                }
              : undefined,
            knownApps,
          });
          try {
            if (recipe) await recipe.expand(app, recipe.options);
            else
              await (declaration.default as (app: ApplicationBuilder) => void | Promise<void>)(app);
          } catch (error) {
            if (error instanceof FeatureError || error instanceof ValidationError) throw error;
            throw new FeatureError({
              message: error instanceof Error ? error.message : String(error),
              path: declaration.path,
            });
          }
          const application = app.finish();
          for (const dependency of declaration.dependsOn) {
            if (!application.dependencies.includes(dependency)) {
              application.dependencies.push(dependency);
            }
          }
          application.dependencies.sort();
          plan.recordApplication(application);
        }
        for (const declaration of declarations) {
          if (!isAppRecipe(declaration.default)) continue;
          for (const reference of appReferencesFromOptions(declaration.default.options)) {
            const endpointName = `${reference.app}:${reference.endpoint}`;
            if (!plan.hasEndpoint(endpointName)) {
              throw new ValidationError({
                message: `Application "${declaration.name}" references endpoint "${reference.app}.${reference.endpoint}", which is not declared`,
              });
            }
          }
        }
        plan.sortApplications();
        plan.sortContributions();
      });
    },
    catch: (error) =>
      error instanceof FeatureError || error instanceof ValidationError
        ? error
        : new FeatureError({
            message: error instanceof Error ? error.message : String(error),
            path: rootDir,
          }),
  });
}
