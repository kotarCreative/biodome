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
  vendorVolume: boolean
  mcpEnabled: boolean
  mcpPort: number
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
  namedVolumes: NamedVolume[]
  volumes: Volume[]
  ports: Port[]
  environment: Record<string, string>
  processes: Process[]
  endpoints: Endpoint[]
  envVars: EnvVar[]
}

export type EnvScope = "build" | "runtime" | "both"

// A declared environment variable. Its value is EITHER a literal (baked into the
// image / plan) OR a passthrough reference that is resolved from the host at
// `up` time and never written to the Dockerfile or plan.json. Passthrough is the
// safe way to inject secrets.
export interface EnvVar {
  key: string
  scope: EnvScope
  // Present when the value is a literal (non-secret config).
  value?: string
  // Present when the value is passed through from the host environment.
  from?: { env: string }
  // Only meaningful for passthrough vars.
  required?: boolean
  default?: string
}

// A SecretValue is either a plain literal string or a reference to an
// environment variable resolved at runtime. Env references are never baked into
// plan.json, keeping secrets out of on-disk artifacts.
export type SecretValue = string | { env: string }

// A user-declared, agent-discoverable resource — e.g. a custom API a feature
// stands up. Captures how to reach it (url/port) plus optional credentials and
// free-form metadata.
export interface Endpoint {
  name: string
  description?: string
  url?: string
  port?: number
  credentials?: Record<string, SecretValue>
  metadata?: Record<string, string>
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

export interface NamedVolume {
  name: string
}

export type VolumeType = "local" | "s3" | "s3-file" | "dropbox" | "gdrive"

export interface Volume {
  name: string
  type: VolumeType
  source?: string
  target: string
  bucket?: string
  key?: string
  prefix?: string
  path?: string
  credentials?: Record<string, SecretValue>
  options?: Record<string, string>
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
      vendorVolume: false,
      mcpEnabled: false,
      mcpPort: 3001,
    },
    runtime: {
      services: [],
      networks: [{ name: "biodome", driver: "bridge" }],
      namedVolumes: [],
      volumes: [],
      ports: [],
      environment: {},
      processes: [],
      endpoints: [],
      envVars: [],
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

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

// A credential value is either a plain string or an { env: "VAR" } reference
// that resolves from the container's environment at runtime.
export const SecretValueSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    env: Schema.String.check(Schema.isMinLength(1)).check(
      Schema.makeFilter((value) =>
        ENV_VAR_NAME_PATTERN.test(value) ? undefined : "must be a valid environment variable name"
      )
    ),
  }),
])

export const EndpointCredentialsSchema = Schema.Record(Schema.String, SecretValueSchema)

export const EndpointSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  credentials: Schema.optional(EndpointCredentialsSchema),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export const VolumeCredentialsSchema = Schema.Record(Schema.String, SecretValueSchema)

export const VolumeSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literals(["local", "s3", "s3-file", "dropbox", "gdrive"]),
  source: Schema.optional(Schema.String),
  target: Schema.String.check(Schema.isMinLength(1)),
  bucket: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  credentials: Schema.optional(VolumeCredentialsSchema),
  options: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export const EnvScopeSchema = Schema.Literals(["build", "runtime", "both"])

// Input spec for addEnv. Exactly one of `value` (literal) or `from` (host
// passthrough) must be provided; addEnv enforces that XOR at runtime.
export const EnvSpecSchema = Schema.Struct({
  value: Schema.optional(Schema.String),
  from: Schema.optional(
    Schema.Struct({
      env: Schema.String.check(Schema.isMinLength(1)).check(
        Schema.makeFilter((value) =>
          ENV_VAR_NAME_PATTERN.test(value) ? undefined : "must be a valid environment variable name"
        )
      ),
    })
  ),
  scope: Schema.optional(EnvScopeSchema),
  required: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.String),
})

// Normalized EnvVar as stored on the plan (round-trippable in plan.json).
export const EnvVarSchema = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  scope: EnvScopeSchema,
  value: Schema.optional(Schema.String),
  from: Schema.optional(Schema.Struct({ env: Schema.String })),
  required: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.String),
})

export const McpConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.optional(Schema.Number),
})

export const ConfigSchema = Schema.Struct({
  project: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1)),
  }),
  mcp: Schema.optional(McpConfigSchema),
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
    vendorVolume: Schema.Boolean,
    mcpEnabled: Schema.Boolean,
    mcpPort: Schema.Number,
  }),
  runtime: Schema.Struct({
    services: Schema.Array(ServiceSchema),
    networks: Schema.Array(Schema.Struct({ name: Schema.String, driver: Schema.String })),
    namedVolumes: Schema.Array(Schema.Struct({ name: Schema.String })),
    volumes: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        type: Schema.Literals(["local", "s3", "s3-file", "dropbox", "gdrive"]),
        source: Schema.optional(Schema.String),
        target: Schema.String,
        bucket: Schema.optional(Schema.String),
        key: Schema.optional(Schema.String),
        prefix: Schema.optional(Schema.String),
        path: Schema.optional(Schema.String),
        credentials: Schema.optional(VolumeCredentialsSchema),
        options: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      })
    ),
    ports: Schema.Array(PortSchema),
    environment: Schema.Record(Schema.String, Schema.String),
    processes: Schema.Array(ProcessSchema),
    endpoints: Schema.Array(EndpointSpecSchema),
    envVars: Schema.Array(EnvVarSchema),
  }),
})
