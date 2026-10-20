export {
  buildPlan,
  buildPlanEffect,
  buildTargetPlan,
  buildTargetPlanEffect,
  buildTaskPlan,
  buildTaskPlanEffect,
  validateConfig,
  validateConfigEffect,
  validateFeatures,
  validateFeaturesEffect,
  validatePlan,
} from "./builder/index.js";

export type { BuildPlanOptions, Config, McpConfig } from "./builder/index.js";
export { ProfileSchema, listProfiles } from "./core/profiles.js";
export type { ProfileDefinition } from "./core/profiles.js";
export type {
  Feature,
  FeatureContext,
  TargetContext,
  TaskContext,
  ProcessSpec,
  HookSpec,
  LanguageOptions,
  PackageOptions,
  ToolOptions,
  ServiceOptions,
  EndpointSpec,
  ProviderSpec,
  EnvSpec,
  VolumeSpec,
  RepoSpec,
} from "./core/feature.js";
export type { Plan, RuntimeTarget, TaskSpec } from "./core/plan.js";
export type { TaskSpec as ActionSpec } from "./core/plan.js";
export type { TaskContext as ActionContext } from "./core/feature.js";
export {
  buildTaskPlan as buildActionPlan,
  buildTaskPlanEffect as buildActionPlanEffect,
} from "./builder/index.js";
