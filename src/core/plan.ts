// Core Plan types for the sandbox intermediate representation.
// Every feature contributes to a shared Plan, and generators read from it.

export interface BuildPlan {
  project: string;
  baseImage: string;
  aptPackages: string[];
  languageSnippets: string[];
  dependencyFiles: string[];
  dependencyInstalls: DependencyInstall[];
  copyArtifacts: CopyArtifact[];
  environment: Record<string, string>;
  nodeModulesVolume: boolean;
  venvVolume: boolean;
}

export interface DependencyInstall {
  files: string[];
  command: string;
}

export interface CopyArtifact {
  files: string[];
  lines: string[];
}

export interface RuntimePlan {
  services: Service[];
  networks: Network[];
  volumes: Volume[];
  ports: Port[];
  environment: Record<string, string>;
  processes: Process[];
}

export interface Service {
  name: string;
  type: string;
  image: string;
  containerName: string;
  environment: Record<string, string>;
  ports: PortMapping[];
  volumes: VolumeMapping[];
  healthCheck?: HealthCheck;
  networks: string[];
}

export interface PortMapping {
  host: number;
  container: number;
}

export interface VolumeMapping {
  host: string;
  container: string;
}

export interface HealthCheck {
  test: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

export interface Network {
  name: string;
  driver: string;
}

export interface Volume {
  name: string;
}

export interface Port {
  name?: string;
  host: number;
  container: number;
}

export interface Process {
  name: string;
  command: string[];
  ports: Port[];
  environment: Record<string, string>;
  workingDir?: string;
  healthCheck?: ProcessHealthCheck;
  mode: "daemon" | "oneshot";
  startOn: LifecyclePoint;
}

export interface ProcessHealthCheck {
  type: "http" | "tcp" | "exec";
  url?: string;
  command?: string[];
  port?: number;
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

export type LifecyclePoint =
  | "build.pre"
  | "build.post"
  | "start.pre"
  | "start.post"
  | "stop.pre"
  | "stop.post"
  | "exec.pre"
  | "exec.post";

export interface Plan {
  project: string;
  build: BuildPlan;
  runtime: RuntimePlan;
}

export function createPlan(project: string): Plan {
  return {
    project,
    build: {
      project,
      baseImage: "",
      aptPackages: [],
      languageSnippets: [],
      dependencyFiles: [],
      dependencyInstalls: [],
      copyArtifacts: [],
      environment: {},
      nodeModulesVolume: false,
      venvVolume: false,
    },
    runtime: {
      services: [],
      networks: [{ name: "sandbox", driver: "bridge" }],
      volumes: [],
      ports: [],
      environment: {},
      processes: [],
    },
  };
}
