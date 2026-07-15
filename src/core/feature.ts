import { Plan, LifecyclePoint } from "./plan.js";

export interface Feature {
  name: string;
  type: string;
  contribute(ctx: FeatureContext): void;
}

export interface FeatureContext {
  plan: Plan;

  addProcess(spec: ProcessSpec): void;
  addHook(spec: HookSpec): void;

  addLanguage(name: string, options?: LanguageOptions): void;
  addPackage(manager: string, name: string, options?: PackageOptions): void;
  addAptPackage(name: string): void;
  addTool(name: string, options?: ToolOptions): void;
  addService(name: string, options?: ServiceOptions): void;

  setEnv(key: string, value: string): void;

  fileExists(path: string): boolean;
  readFile(path: string): string;
  readJSON(path: string): unknown;
  exec(command: string): { stdout: string; stderr: string; exitCode: number };
}

export interface ProcessSpec {
  name: string;
  command: string[];
  port?: number;
  ports?: Record<string, number>;
  environment?: Record<string, string>;
  workingDir?: string;
  healthCheck?: ProcessHealthCheckSpec;
  mode?: "daemon" | "oneshot";
  startOn?: LifecyclePoint;
}

export interface HookSpec extends ProcessSpec {
  startOn: LifecyclePoint;
}

export interface ProcessHealthCheckSpec {
  type?: "http" | "tcp" | "exec";
  url?: string;
  command?: string[];
  port?: number;
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

export interface LanguageOptions {
  version?: string;
  packageManager?: string;
}

export interface PackageOptions {
  version?: string;
  indexUrl?: string;
}

export interface ToolOptions {
  version?: string;
}

export interface ServiceOptions {
  image?: string;
  port?: number;
  environment?: Record<string, string>;
  databases?: Array<{ name: string }>;
  users?: Array<{ name: string; password: string }>;
  password?: string;
}

export type FeatureConstructor = (name: string, raw: unknown) => Feature;

export class Registry {
  private constructors = new Map<string, FeatureConstructor>();

  register(type: string, ctor: FeatureConstructor): void {
    this.constructors.set(type, ctor);
  }

  create(type: string, name: string, raw: unknown): Feature {
    const ctor = this.constructors.get(type);
    if (!ctor) {
      throw new Error(`Unknown feature type ${type}`);
    }
    return ctor(name, raw);
  }

  has(type: string): boolean {
    return this.constructors.has(type);
  }

  types(): string[] {
    return Array.from(this.constructors.keys()).sort();
  }
}

