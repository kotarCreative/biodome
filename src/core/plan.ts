// Core Plan types for the sandbox intermediate representation.
// Every feature contributes to a shared Plan, and generators read from it.

import { Schema } from "effect"

export interface LanguageRequest {
  name: string
  options: { version?: string; packageManager?: string }
}

export interface BuildPlan {
  project: string
  baseImage: string
  aptPackages: string[]
  runtimeInstalls: string[]
  languageSnippets: string[]
  languageRequests: LanguageRequest[]
  dependencyFiles: string[]
  dependencyInstalls: DependencyInstall[]
  copyArtifacts: CopyArtifact[]
  environment: Record<string, string>
  nodeModulesVolume: boolean
  venvVolume: boolean
}

export interface DependencyInstall {
  files: string[]
  command: string
}

export interface CopyArtifact {
  files: string[]
  lines: string[]
}

export interface RuntimePlan {
  services: Service[]
  networks: Network[]
  volumes: Volume[]
  ports: Port[]
  environment: Record<string, string>
  processes: Process[]
}

export interface Service {
  name: string
  type: string
  image: string
  containerName: string
  environment: Record<string, string>
  ports: PortMapping[]
  volumes: VolumeMapping[]
  healthCheck?: HealthCheck
  networks: string[]
}

export interface PortMapping {
  host: number
  container: number
}

export interface VolumeMapping {
  host: string
  container: string
}

export interface HealthCheck {
  test: string[]
  interval?: string
  timeout?: string
  retries?: number
  startPeriod?: string
}

export interface Network {
  name: string
  driver: string
}

export interface Volume {
  name: string
}

export interface Port {
  name?: string
  host: number
  container: number
}

export interface Process {
  name: string
  command: string[]
  ports: Port[]
  environment: Record<string, string>
  workingDir?: string
  healthCheck?: ProcessHealthCheck
  mode: "daemon" | "oneshot"
  startOn: LifecyclePoint
}

export interface ProcessHealthCheck {
  type: "http" | "tcp" | "exec"
  url?: string
  command?: string[]
  port?: number
  interval?: string
  timeout?: string
  retries?: number
  startPeriod?: string
}

export type LifecyclePoint =
  | "build.pre"
  | "build.post"
  | "start.pre"
  | "start.post"
  | "stop.pre"
  | "stop.post"
  | "exec.pre"
  | "exec.post"

export const LIFECYCLE_POINTS = new Set<LifecyclePoint>([
  "build.pre",
  "build.post",
  "start.pre",
  "start.post",
  "stop.pre",
  "stop.post",
  "exec.pre",
  "exec.post",
])

export const LifecyclePointSchema = Schema.Literals([
  "build.pre",
  "build.post",
  "start.pre",
  "start.post",
  "stop.pre",
  "stop.post",
  "exec.pre",
  "exec.post",
])

export interface Plan {
  project: string
  build: BuildPlan
  runtime: RuntimePlan
}

export function createPlan(project: string): Plan {
  return {
    project,
    build: {
      project,
      baseImage: "",
      aptPackages: [],
      runtimeInstalls: [],
      languageSnippets: [],
      languageRequests: [],
      dependencyFiles: [],
      dependencyInstalls: [],
      copyArtifacts: [],
      environment: {},
      nodeModulesVolume: false,
      venvVolume: false,
    },
    runtime: {
      services: [],
      networks: [{ name: "biodome", driver: "bridge" }],
      volumes: [],
      ports: [],
      environment: {},
      processes: [],
    },
  }
}

// Schema-backed validation for incoming user specs.

export const ProcessHealthCheckSpecSchema = Schema.Struct({
  type: Schema.optional(Schema.Literals(["http", "tcp", "exec"])),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
  port: Schema.optional(Schema.Number),
  interval: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.String),
  retries: Schema.optional(Schema.Number),
  startPeriod: Schema.optional(Schema.String),
})

export const ProcessSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  port: Schema.optional(Schema.Number),
  ports: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  workingDir: Schema.optional(Schema.String),
  healthCheck: Schema.optional(ProcessHealthCheckSpecSchema),
  mode: Schema.optional(Schema.Literals(["daemon", "oneshot"])),
  startOn: Schema.optional(LifecyclePointSchema),
})

export const HookSpecSchema = ProcessSpecSchema.pipe(
  Schema.check(
    Schema.makeFilter((spec) =>
      spec.startOn !== undefined ? undefined : "Hook requires a startOn lifecycle point"
    )
  )
)

export const LanguageOptionsSchema = Schema.Struct({
  version: Schema.optional(Schema.String),
  packageManager: Schema.optional(Schema.String),
})

export const PackageOptionsSchema = Schema.Struct({
  version: Schema.optional(Schema.String),
  indexUrl: Schema.optional(Schema.String),
})

export const ToolOptionsSchema = Schema.Struct({
  version: Schema.optional(Schema.String),
})

export const ServiceUserSchema = Schema.Struct({
  name: Schema.String,
  password: Schema.String,
})

export const ServiceDatabaseSchema = Schema.Struct({
  name: Schema.String,
})

export const ServiceOptionsSchema = Schema.Struct({
  image: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  databases: Schema.optional(Schema.Array(ServiceDatabaseSchema)),
  users: Schema.optional(Schema.Array(ServiceUserSchema)),
  password: Schema.optional(Schema.String),
})

export const ConfigSchema = Schema.Struct({
  project: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1)),
  }),
})

export const PortSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  host: Schema.Number,
  container: Schema.Number,
})

export const ProcessSchema = Schema.Struct({
  name: Schema.String,
  command: Schema.Array(Schema.String),
  ports: Schema.Array(PortSchema),
  environment: Schema.Record(Schema.String, Schema.String),
  workingDir: Schema.optional(Schema.String),
  healthCheck: Schema.optional(ProcessHealthCheckSpecSchema),
  mode: Schema.Literals(["daemon", "oneshot"]),
  startOn: LifecyclePointSchema,
})

export const ServiceSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  image: Schema.String,
  containerName: Schema.String,
  environment: Schema.Record(Schema.String, Schema.String),
  ports: Schema.Array(PortSchema),
  volumes: Schema.Array(Schema.Struct({ host: Schema.String, container: Schema.String })),
  healthCheck: Schema.optional(
    Schema.Struct({
      test: Schema.Array(Schema.String),
      interval: Schema.optional(Schema.String),
      timeout: Schema.optional(Schema.String),
      retries: Schema.optional(Schema.Number),
      startPeriod: Schema.optional(Schema.String),
    })
  ),
  networks: Schema.Array(Schema.String),
})

export const PlanSchema = Schema.Struct({
  project: Schema.String,
  build: Schema.Struct({
    project: Schema.String,
    baseImage: Schema.String,
    aptPackages: Schema.Array(Schema.String),
    runtimeInstalls: Schema.Array(Schema.String),
    languageSnippets: Schema.Array(Schema.String),
    languageRequests: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        options: LanguageOptionsSchema,
      })
    ),
    dependencyFiles: Schema.Array(Schema.String),
    dependencyInstalls: Schema.Array(
      Schema.Struct({ files: Schema.Array(Schema.String), command: Schema.String })
    ),
    copyArtifacts: Schema.Array(
      Schema.Struct({ files: Schema.Array(Schema.String), lines: Schema.Array(Schema.String) })
    ),
    environment: Schema.Record(Schema.String, Schema.String),
    nodeModulesVolume: Schema.Boolean,
    venvVolume: Schema.Boolean,
  }),
  runtime: Schema.Struct({
    services: Schema.Array(ServiceSchema),
    networks: Schema.Array(Schema.Struct({ name: Schema.String, driver: Schema.String })),
    volumes: Schema.Array(Schema.Struct({ name: Schema.String })),
    ports: Schema.Array(PortSchema),
    environment: Schema.Record(Schema.String, Schema.String),
    processes: Schema.Array(ProcessSchema),
  }),
})
