import type {
  EndpointSpec,
  EnvSpec,
  HookSpec,
  LanguageOptions,
  PackageOptions,
  ProcessSpec,
  RepoSpec,
  ToolOptions,
} from "../core/feature.js";

export const APP_RECIPE_API_VERSION = 1 as const;

export interface AppEndpointReference {
  readonly _tag: "AppEndpointReference";
  readonly app: string;
  readonly endpoint: string;
}

export interface ServiceReference {
  readonly _tag: "ServiceReference";
  readonly service: string;
}

export interface AppReferenceBuilder {
  endpoint(name?: string): AppEndpointReference;
}

export interface AppRecipe<TOptions = unknown> {
  readonly _tag: "AppRecipe";
  readonly id: string;
  /** Optional published package version for plan provenance. */
  readonly version?: string;
  readonly apiVersion: typeof APP_RECIPE_API_VERSION;
  readonly options: TOptions;
  readonly expand: (app: ApplicationBuilder, options: TOptions) => void | Promise<void>;
}

export interface AppRecipeDefinition<TOptions> {
  id: string;
  /** Optional published package version for plan provenance. */
  version?: string;
  apiVersion: typeof APP_RECIPE_API_VERSION;
  expand(app: ApplicationBuilder, options: TOptions): void | Promise<void>;
}

export interface RepoRef {
  readonly name: string;
  readonly path: string;
}

export interface HookRef {
  readonly name: string;
}

export interface ProcessRef {
  readonly name: string;
  readonly port?: number;
}

export interface EndpointRef {
  readonly name: string;
  readonly port?: number;
}

export type AppRepositoryOptions = Omit<RepoSpec, "name" | "path"> & {
  name?: string;
  path?: string;
};
export type AppEnvironmentValue = EnvSpec;
export interface ServiceBinding {
  environment?: Record<string, string>;
}
export type AppHookOptions = Omit<HookSpec, "name" | "workingDir"> & { workingDir?: string };
export type AppProcessOptions = Omit<ProcessSpec, "name" | "workingDir"> & { workingDir?: string };
export type AppEndpointOptions = Omit<EndpointSpec, "name" | "port"> & {
  process?: string;
  port?: number;
};

/** The constrained, application-scoped authoring surface exposed to recipes. */
export interface ApplicationBuilder {
  readonly name: string;
  readonly root: string;

  addLanguage(name: string, options?: LanguageOptions): void;
  addTool(name: string, options?: ToolOptions): void;
  addPackage(manager: string, name: string, options?: PackageOptions): void;
  addRepository(options: AppRepositoryOptions): RepoRef;
  addEnvironment(key: string, spec: AppEnvironmentValue): void;
  requireService(name: string | ServiceReference, binding?: ServiceBinding): ServiceReference;
  addHook(name: string, options: AppHookOptions): HookRef;
  addProcess(name: string, options: AppProcessOptions): ProcessRef;
  exposeEndpoint(name: string, options: AppEndpointOptions): EndpointRef;
  requireAppEndpoint(reference: AppEndpointReference): AppEndpointReference;
}

export interface AppRecipeMetadata {
  id: string;
  version?: string;
  declarationPath: string;
}

export interface Application {
  name: string;
  root: string;
  recipe?: AppRecipeMetadata;
  declarationPath: string;
  repositories: string[];
  hooks: string[];
  processes: string[];
  endpoints: string[];
  requiredServices: string[];
  dependencies: string[];
}

export interface ContributionSource {
  application: string;
  recipe?: string;
  recipeVersion?: string;
  declarationPath: string;
  localName: string;
}

export interface ContributionProvenance {
  kind: "repository" | "hook" | "process" | "endpoint" | "language" | "tool" | "package";
  qualifiedName: string;
  source: ContributionSource;
}
