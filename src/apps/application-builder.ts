import { posix } from "node:path";
import type { FeatureContext } from "../core/feature.js";
import { ValidationError } from "../core/errors.js";
import { isServiceReference } from "./references.js";
import type {
  AppEndpointOptions,
  AppEndpointReference,
  AppHookOptions,
  AppProcessOptions,
  AppRepositoryOptions,
  Application,
  ApplicationBuilder,
  AppRecipeMetadata,
  ContributionProvenance,
  EndpointRef,
  HookRef,
  ProcessRef,
  RepoRef,
  ServiceBinding,
  ServiceReference,
} from "./types.js";

export interface ApplicationBuilderOptions {
  name: string;
  declarationPath: string;
  recipe?: AppRecipeMetadata;
  knownApps: ReadonlySet<string>;
}

export interface ApplicationPlanAccess {
  serviceEnvironment(name: string): Record<string, string> | undefined;
  processPort(name: string): number | null | undefined;
  hasEndpoint(name: string): boolean;
  recordApplication(application: Application): void;
  recordContribution(contribution: ContributionProvenance): void;
  sortApplications(): void;
  sortContributions(): void;
}

function qualifiedDeclaration(app: string, name: string): string {
  if (!name)
    throw new ValidationError({ message: "Application contribution requires a non-empty name" });
  if (name.includes(":")) {
    throw new ValidationError({
      message: `Application "${app}" local declaration name must not contain ":": "${name}"`,
    });
  }
  return `${app}:${name}`;
}

function qualifiedReference(app: string, name: string): string {
  if (!name)
    throw new ValidationError({ message: "Application contribution requires a non-empty name" });
  return name.includes(":") ? name : `${app}:${name}`;
}

function appPath(root: string, path: string | undefined): string {
  if (!path) return root;
  if (path.startsWith("/")) {
    if (path !== root && !path.startsWith(`${root}/`)) {
      throw new ValidationError({
        message: `Application working path must stay within ${root}: ${path}`,
      });
    }
    return path;
  }
  const normalized = posix.normalize(posix.join(root, path));
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new ValidationError({
      message: `Application working path must stay within ${root}: ${path}`,
    });
  }
  return normalized;
}

/** Expands one app into the established feature primitives without provider knowledge. */
export class ApplicationBuilderImpl implements ApplicationBuilder {
  readonly name: string;
  readonly root: string;
  private readonly application: Application;
  private readonly localHooks = new Set<string>();
  private readonly localProcesses = new Map<string, ProcessRef>();
  private readonly localEndpoints = new Set<string>();

  constructor(
    private readonly context: FeatureContext,
    private readonly plan: ApplicationPlanAccess,
    private readonly options: ApplicationBuilderOptions,
  ) {
    this.name = options.name;
    this.root = `/workspace/apps/${options.name}`;
    this.application = {
      name: this.name,
      root: this.root,
      recipe: options.recipe,
      declarationPath: options.declarationPath,
      repositories: [],
      hooks: [],
      processes: [],
      endpoints: [],
      requiredServices: [],
      dependencies: [],
    };
  }

  addLanguage(name: string, options = {}): void {
    this.context.addLanguage(name, options);
    this.contribute("language", name, name);
  }

  addTool(name: string, options = {}): void {
    this.context.addTool(name, options);
    this.contribute("tool", name, name);
  }

  addPackage(manager: string, name: string, options = {}): void {
    this.context.addPackage(manager, name, options);
    this.contribute("package", `${manager}:${name}`, `${manager}:${name}`);
  }

  addRepository(options: AppRepositoryOptions): RepoRef {
    const name = options.name ?? this.name;
    const path = appPath(this.root, options.path);
    this.context.addRepo({ ...options, name, path });
    this.application.repositories.push(name);
    this.contribute("repository", name, name);
    return Object.freeze({ name, path });
  }

  addEnvironment(key: string, spec: Parameters<FeatureContext["addEnv"]>[1]): void {
    this.context.addEnv(key, spec);
  }

  requireService(name: string | ServiceReference, binding?: ServiceBinding): ServiceReference {
    const serviceName = isServiceReference(name) ? name.service : name;
    if (!serviceName)
      throw new ValidationError({ message: `Application ${this.name} requires a service name` });
    const environment = this.plan.serviceEnvironment(serviceName);
    if (!environment) {
      throw new ValidationError({
        message: `Application "${this.name}" requires unknown service "${serviceName}"`,
      });
    }
    if (binding?.environment !== undefined) {
      if (
        typeof binding.environment !== "object" ||
        binding.environment === null ||
        Array.isArray(binding.environment)
      ) {
        throw new ValidationError({
          message: `Application "${this.name}" service "${serviceName}" binding environment must be an object`,
        });
      }
      for (const [applicationKey, serviceKey] of Object.entries(binding.environment)) {
        if (typeof serviceKey !== "string" || !(serviceKey in environment)) {
          throw new ValidationError({
            message: `Application "${this.name}" service "${serviceName}" references invalid environment key "${String(serviceKey)}"`,
          });
        }
        this.context.addEnv(applicationKey, { value: environment[serviceKey] });
      }
    }
    if (!this.application.requiredServices.includes(serviceName)) {
      this.application.requiredServices.push(serviceName);
    }
    return Object.freeze({ _tag: "ServiceReference" as const, service: serviceName });
  }

  requireAppEndpoint(reference: AppEndpointReference): AppEndpointReference {
    if (!this.options.knownApps.has(reference.app)) {
      throw new ValidationError({
        message: `Application "${this.name}" references unknown application "${reference.app}" endpoint "${reference.endpoint}"`,
      });
    }
    const dependency = `${reference.app}:${reference.endpoint}`;
    if (!this.application.dependencies.includes(dependency))
      this.application.dependencies.push(dependency);
    const endpointName = `${reference.app}:${reference.endpoint}`;
    if (!this.plan.hasEndpoint(endpointName)) {
      throw new ValidationError({
        message: `Application "${this.name}" references endpoint "${reference.app}.${reference.endpoint}", which is not declared`,
      });
    }
    return reference;
  }

  addHook(name: string, options: AppHookOptions): HookRef {
    const qualifiedName = qualifiedDeclaration(this.name, name);
    this.checkLocal(this.localHooks, name, "hook");
    this.context.addHook({
      ...options,
      name: qualifiedName,
      workingDir: appPath(this.root, options.workingDir),
    });
    this.application.hooks.push(qualifiedName);
    this.contribute("hook", qualifiedName, name);
    return Object.freeze({ name: qualifiedName });
  }

  addProcess(name: string, options: AppProcessOptions): ProcessRef {
    const qualifiedName = qualifiedDeclaration(this.name, name);
    if (this.localProcesses.has(name)) {
      throw new ValidationError({
        message: `Duplicate process "${name}" in application "${this.name}"`,
      });
    }
    this.context.addProcess({
      ...options,
      name: qualifiedName,
      workingDir: appPath(this.root, options.workingDir),
    });
    const ref = Object.freeze({ name: qualifiedName, port: options.port });
    this.localProcesses.set(name, ref);
    this.application.processes.push(qualifiedName);
    this.contribute("process", qualifiedName, name);
    return ref;
  }

  exposeEndpoint(name: string, options: AppEndpointOptions): EndpointRef {
    const qualifiedName = qualifiedDeclaration(this.name, name);
    this.checkLocal(this.localEndpoints, name, "endpoint");
    const processName = options.process;
    const resolvedProcess = processName
      ? processName.includes(":")
        ? processName
        : qualifiedReference(this.name, processName)
      : undefined;
    const processPort = resolvedProcess ? this.plan.processPort(resolvedProcess) : undefined;
    if (resolvedProcess && processPort === undefined) {
      throw new ValidationError({
        message: `Application "${this.name}" endpoint "${name}" references unknown process "${resolvedProcess}"`,
      });
    }
    const port = options.port ?? processPort ?? undefined;
    this.context.addEndpoint({
      name: qualifiedName,
      description: options.description,
      url: options.url,
      port,
      credentials: options.credentials,
      metadata: options.metadata,
    });
    this.application.endpoints.push(qualifiedName);
    this.contribute("endpoint", qualifiedName, name);
    return Object.freeze({ name: qualifiedName, port });
  }

  finish(): Application {
    this.application.repositories.sort();
    this.application.hooks.sort();
    this.application.processes.sort();
    this.application.endpoints.sort();
    this.application.requiredServices.sort();
    this.application.dependencies.sort();
    return this.application;
  }

  private checkLocal(entries: Set<string>, name: string, kind: string): void {
    if (entries.has(name))
      throw new ValidationError({
        message: `Duplicate ${kind} "${name}" in application "${this.name}"`,
      });
    entries.add(name);
  }

  private contribute(
    kind: "repository" | "hook" | "process" | "endpoint" | "language" | "tool" | "package",
    qualifiedName: string,
    localName: string,
  ): void {
    this.plan.recordContribution({
      kind,
      qualifiedName,
      source: {
        application: this.name,
        recipe: this.options.recipe?.id,
        recipeVersion: this.options.recipe?.version,
        declarationPath: this.options.declarationPath,
        localName,
      },
    });
  }
}
