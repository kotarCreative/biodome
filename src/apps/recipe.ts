import { APP_RECIPE_API_VERSION, type AppRecipe, type AppRecipeDefinition } from "./types.js";

export function defineAppRecipe<TOptions>(
  definition: AppRecipeDefinition<TOptions>,
): (options: TOptions) => AppRecipe<TOptions> {
  if (!definition.id || typeof definition.id !== "string") {
    throw new Error("App recipe requires a non-empty id");
  }
  if (
    definition.version !== undefined &&
    (typeof definition.version !== "string" || definition.version.trim().length === 0)
  ) {
    throw new Error(`App recipe ${definition.id} version must be a non-empty string when provided`);
  }
  if (definition.apiVersion !== APP_RECIPE_API_VERSION) {
    throw new Error(
      `Unsupported app recipe API version for ${definition.id}: ${definition.apiVersion}; supported version is ${APP_RECIPE_API_VERSION}`,
    );
  }
  if (typeof definition.expand !== "function") {
    throw new Error(`App recipe ${definition.id} requires an expand function`);
  }

  return (options: TOptions): AppRecipe<TOptions> =>
    Object.freeze({
      _tag: "AppRecipe" as const,
      id: definition.id,
      version: definition.version,
      apiVersion: APP_RECIPE_API_VERSION,
      options,
      expand: definition.expand,
    });
}

export function isAppRecipe(value: unknown): value is AppRecipe<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { _tag?: unknown })._tag === "AppRecipe" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { expand?: unknown }).expand === "function"
  );
}
