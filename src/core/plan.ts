// Core Plan types for the sandbox intermediate representation.
// Every feature contributes to a shared Plan, and generators read from it.

import { Schema } from "effect";

export interface LanguageRequest {
  name: string;
  options: { version?: string; packageManager?: string };
}

export interface McpConfig {
  enabled: boolean;
  port: number;
  token?: SecretValue;
  allowExec: boolean;
  allowProcessControl: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
}

export interface BuildPlan {
  project: string;
  baseImage: string;
  aptPackages: string[];
  runtimeInstalls: string[];
  languageSnippets: string[];
  languageRequests: LanguageRequest[];
  dependencyFiles: string[];
  dependencyInstalls: DependencyInstall[];
  copyArtifacts: CopyArtifact[];
  environment: Record<string, string>;
  nodeModulesVolume: boolean;
  venvVolume: boolean;
  vendorVolume: boolean;
  mcpEnabled: boolean;
  mcpPort: number;
  mcpConfig: McpConfig;
}

export interface DependencyInstall {
  files: string[];
  command: string;
}

export interface CopyArtifact {
  files: string[];
  lines: string[];
}

export interface Repo {
  name: string;
  url: string;
  path: string;
  branch: string;
  depth?: number;
  credentials?: RepoCredentials;
}

export interface RepoCredentials {
  token?: SecretValue;
  sshKey?: SecretValue;
}

export interface AgentHarnessMcpServer {
  url: string;
}

export interface AgentHarnessTelemetry {
  enabled: boolean;
  path: string;
  capturePayloads?: boolean;
}

export interface AgentHarness {
  name: string;
  type: string;
  port: number;
  mcpServers: Record<string, AgentHarnessMcpServer>;
  telemetry: AgentHarnessTelemetry;
  config: Record<string, unknown>;
}

export interface LlmProvider {
  name: string;
  npm?: string;
  displayName?: string;
  options: Record<string, SecretValue | string | number | boolean | undefined>;
  models: Record<string, { name?: string }>;
}

export interface PiHarness {
  name: string;
  type: "pi";
  provider?: string;
  model?: string;
  apiKey?: SecretValue;
  tools?: string[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  packages?: string[];
  telemetry: AgentHarnessTelemetry;
  config: Record<string, unknown>;
}

export interface CodexHarness {
  name: string;
  type: "codex";
  port: number;
  mcpServers: Record<string, AgentHarnessMcpServer>;
  apiKey?: SecretValue;
  model?: string;
  telemetry: AgentHarnessTelemetry;
  config: Record<string, unknown>;
}

export interface ClaudeHarness {
  name: string;
  type: "claude";
  apiKey?: SecretValue;
  model?: string;
  tools?: string[];
  permissions?: string;
  telemetry: AgentHarnessTelemetry;
  config: Record<string, unknown>;
}

export interface RuntimePlan {
  services: Service[];
  networks: Network[];
  namedVolumes: NamedVolume[];
  volumes: Volume[];
  ports: Port[];
  environment: Record<string, string>;
  processes: Process[];
  endpoints: Endpoint[];
  providers: Provider[];
  envVars: EnvVar[];
  repos: Repo[];
  agentHarnesses: AgentHarness[];
  piHarnesses: PiHarness[];
  codexHarnesses: CodexHarness[];
  claudeHarnesses: ClaudeHarness[];
  llmProviders: LlmProvider[];
}

// --- Target and task types ---

export type RuntimeDriverId = "docker-compose" | "aws-ecs" | (string & {});

export interface RuntimeTarget {
  name: string;
  driver: RuntimeDriverId;
  options: Record<string, unknown>;
}

export interface TaskSpec {
  harness: string;
  prompt: string;
  artifacts: string[];
  timeout: string;
  cleanup: "always" | "on-success" | "never";
}

export interface Task {
  name: string;
  harness: string;
  prompt: string;
  artifacts: string[];
  timeout: string;
  cleanup: "always" | "on-success" | "never";
}

export interface DeploymentPlan {
  target: RuntimeTarget;
  task?: Task;
  deploymentId: string;
}

export type EnvScope = "build" | "runtime" | "both";

// A declared environment variable. Its value is EITHER a literal (baked into the
// image / plan) OR a passthrough reference that is resolved from the host at
// `up` time and never written to the Dockerfile or plan.json. Passthrough is the
// safe way to inject secrets.
export interface EnvVar {
  key: string;
  scope: EnvScope;
  // Present when the value is a literal (non-secret config).
  value?: string;
  // Present when the value is passed through from the host environment.
  from?: { env: string };
  // Only meaningful for passthrough vars.
  required?: boolean;
  default?: string;
}

// A SecretValue is either a plain literal string or a reference to an
// environment variable resolved at runtime. Env references are never baked into
// plan.json, keeping secrets out of on-disk artifacts.
export type SecretValue = string | { env: string };

// A user-declared, agent-discoverable resource — e.g. a custom API a feature
// stands up. Captures how to reach it (url/port) plus optional credentials and
// free-form metadata.
export interface Endpoint {
  name: string;
  description?: string;
  url?: string;
  port?: number;
  credentials?: Record<string, SecretValue>;
  metadata?: Record<string, string>;
}

// A user-declared external provider — e.g. Jira, GitHub, Slack. Providers are
// well-known SaaS APIs that the agent may call through MCP tools. They capture
// the instance URL, an optional project/team scope, credentials, and free-form
// metadata.
export interface Provider {
  name: string;
  type: string;
  url?: string;
  project?: string;
  mcpUrl?: string;
  authHeader?: string;
  authScheme?: string;
  authCredential?: string;
  credentials?: Record<string, SecretValue>;
  metadata?: Record<string, string>;
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

export interface NamedVolume {
  name: string;
}

export type VolumeType =
  | "local"
  | "s3"
  | "gcs"
  | "azure"
  | "sftp"
  | "smb"
  | "webdav"
  | "dropbox"
  | "gdrive";

export interface Volume {
  name: string;
  type: VolumeType;
  source?: string;
  target: string;
  bucket?: string;
  prefix?: string;
  path?: string;
  // Cloud / network providers
  endpoint?: string;
  account?: string;
  container?: string;
  host?: string;
  port?: number;
  export?: string;
  share?: string;
  url?: string;
  vendor?: string;
  credentials?: Record<string, SecretValue>;
  options?: Record<string, string>;
  // MCP proxy mode: when true, the volume is not mounted in the dev container.
  // The MCP server exposes file-access tools and uses provider SDKs/adapters.
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
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
  // When false, the process environment is not merged into the global runtime
  // environment. This keeps sensitive env vars (e.g. MCP proxy credentials) out of
  // the dev service's compose environment.
  mergeEnv?: boolean;
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

export const LIFECYCLE_POINTS = new Set<LifecyclePoint>([
  "build.pre",
  "build.post",
  "start.pre",
  "start.post",
  "stop.pre",
  "stop.post",
  "exec.pre",
  "exec.post",
]);

export const LifecyclePointSchema = Schema.Literals([
  "build.pre",
  "build.post",
  "start.pre",
  "start.post",
  "stop.pre",
  "stop.post",
  "exec.pre",
  "exec.post",
]);

export interface Plan {
  project: string;
  build: BuildPlan;
  runtime: RuntimePlan;
  deployment?: DeploymentPlan;
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
      mcpConfig: {
        enabled: false,
        port: 3001,
        allowExec: false,
        allowProcessControl: false,
        maxReadBytes: 1048576,
        maxWriteBytes: 2097152,
        maxListEntries: 100,
      },
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
      providers: [],
      envVars: [],
      repos: [],
      agentHarnesses: [],
      piHarnesses: [],
      codexHarnesses: [],
      claudeHarnesses: [],
      llmProviders: [],
    },
  };
}

// --- Target/task name and duration validation ---

const TARGET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validateTargetName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("Target name must be a non-empty string");
  }
  if (!TARGET_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid target name: "${name}". Must match ${TARGET_NAME_PATTERN.source}`);
  }
  if (name === "." || name === "..") {
    throw new Error(`Invalid target name: "${name}"`);
  }
  if (name.length > 64) {
    throw new Error(`Target name too long (${name.length} chars, max 64)`);
  }
}

const DURATION_PATTERN = /^(\d+)(s|m|h)$/;

export function parseDuration(value: string): number {
  if (!value || typeof value !== "string") {
    throw new Error(`Duration must be a non-empty string`);
  }
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `Invalid duration: "${value}". Use positive integer + s/m/h (e.g. "30s", "5m", "2h")`,
    );
  }
  const num = parseInt(match[1], 10);
  if (num <= 0) {
    throw new Error(`Duration must be positive: "${value}"`);
  }
  const unit = match[2];
  switch (unit) {
    case "s":
      return num;
    case "m":
      return num * 60;
    case "h":
      return num * 3600;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export function validateArtifactPath(path: string): void {
  if (!path || typeof path !== "string") {
    throw new Error("Artifact path must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new Error("Artifact path must not contain NUL byte");
  }
  if (path.startsWith("/")) {
    throw new Error("Artifact path must not be absolute");
  }
  for (const segment of path.split("/")) {
    if (segment === "..") {
      throw new Error("Artifact path must not contain .. segments");
    }
  }
}

export function isJsonSafeValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "number") return true;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonSafeValue);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).every(isJsonSafeValue);
  }
  return false;
}

export function validateJsonSafeOptions(value: unknown, label: string): void {
  if (!isJsonSafeValue(value)) {
    throw new Error(
      `${label} contains non-JSON-safe values (functions, symbols, undefined, dates, etc.)`,
    );
  }
}

// --- Schema-backed validation ---

export const ProcessHealthCheckSpecSchema = Schema.Struct({
  type: Schema.optional(Schema.Literals(["http", "tcp", "exec"])),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
  port: Schema.optional(Schema.Number),
  interval: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.String),
  retries: Schema.optional(Schema.Number),
  startPeriod: Schema.optional(Schema.String),
});

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
  mergeEnv: Schema.optional(Schema.Boolean),
});

export const HookSpecSchema = ProcessSpecSchema.pipe(
  Schema.check(
    Schema.makeFilter((spec) =>
      spec.startOn !== undefined ? undefined : "Hook requires a startOn lifecycle point",
    ),
  ),
);

export const LanguageOptionsSchema = Schema.Struct({
  version: Schema.optional(Schema.String),
  packageManager: Schema.optional(Schema.String),
});

export const PackageOptionsSchema = Schema.Struct({
  version: Schema.optional(Schema.String),
  indexUrl: Schema.optional(Schema.String),
});

export const ToolOptionsSchema = Schema.Struct({
  version: Schema.optional(Schema.String),
});

export const ServiceUserSchema = Schema.Struct({
  name: Schema.String,
  password: Schema.String,
});

export const ServiceDatabaseSchema = Schema.Struct({
  name: Schema.String,
});

export const ServiceOptionsSchema = Schema.Struct({
  image: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  databases: Schema.optional(Schema.Array(ServiceDatabaseSchema)),
  users: Schema.optional(Schema.Array(ServiceUserSchema)),
  password: Schema.optional(Schema.String),
});

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A credential value is either a plain string or an { env: "VAR" } reference
// that resolves from the container's environment at runtime.
export const SecretValueSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    env: Schema.String.check(Schema.isMinLength(1)).check(
      Schema.makeFilter((value) =>
        ENV_VAR_NAME_PATTERN.test(value) ? undefined : "must be a valid environment variable name",
      ),
    ),
  }),
]);

export const RepoCredentialsSchema = Schema.Struct({
  token: Schema.optional(SecretValueSchema),
  sshKey: Schema.optional(SecretValueSchema),
});

export const RepoSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  url: Schema.String.check(Schema.isMinLength(1)),
  path: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  depth: Schema.optional(Schema.Number),
  credentials: Schema.optional(RepoCredentialsSchema),
});

export const RepoSchema = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  depth: Schema.optional(Schema.Number),
  credentials: Schema.optional(RepoCredentialsSchema),
});

export const AgentHarnessMcpServerSchema = Schema.Struct({
  url: Schema.String,
});

export const AgentHarnessTelemetrySchema = Schema.Struct({
  enabled: Schema.Boolean,
  path: Schema.String,
  capturePayloads: Schema.optional(Schema.Boolean),
});

export const AgentHarnessSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.optional(Schema.Number),
  mcpServers: Schema.optional(Schema.Record(Schema.String, AgentHarnessMcpServerSchema)),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      path: Schema.optional(Schema.String),
      capturePayloads: Schema.optional(Schema.Boolean),
    }),
  ),
  config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export const AgentHarnessSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  port: Schema.Number,
  mcpServers: Schema.Record(Schema.String, AgentHarnessMcpServerSchema),
  telemetry: AgentHarnessTelemetrySchema,
  config: Schema.Record(Schema.String, Schema.Unknown),
});

export const PiHarnessSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  apiKey: Schema.optional(SecretValueSchema),
  tools: Schema.optional(Schema.Array(Schema.String)),
  extensions: Schema.optional(Schema.Array(Schema.String)),
  skills: Schema.optional(Schema.Array(Schema.String)),
  prompts: Schema.optional(Schema.Array(Schema.String)),
  themes: Schema.optional(Schema.Array(Schema.String)),
  packages: Schema.optional(Schema.Array(Schema.String)),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      path: Schema.optional(Schema.String),
      capturePayloads: Schema.optional(Schema.Boolean),
    }),
  ),
  config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export const PiHarnessSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["pi"]),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  apiKey: Schema.optional(SecretValueSchema),
  tools: Schema.optional(Schema.Array(Schema.String)),
  extensions: Schema.optional(Schema.Array(Schema.String)),
  skills: Schema.optional(Schema.Array(Schema.String)),
  prompts: Schema.optional(Schema.Array(Schema.String)),
  themes: Schema.optional(Schema.Array(Schema.String)),
  packages: Schema.optional(Schema.Array(Schema.String)),
  telemetry: AgentHarnessTelemetrySchema,
  config: Schema.Record(Schema.String, Schema.Unknown),
});

export const CodexHarnessSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.optional(Schema.Number),
  mcpServers: Schema.optional(Schema.Record(Schema.String, AgentHarnessMcpServerSchema)),
  apiKey: Schema.optional(SecretValueSchema),
  model: Schema.optional(Schema.String),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      path: Schema.optional(Schema.String),
      capturePayloads: Schema.optional(Schema.Boolean),
    }),
  ),
  config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export const CodexHarnessSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["codex"]),
  port: Schema.Number,
  mcpServers: Schema.Record(Schema.String, AgentHarnessMcpServerSchema),
  apiKey: Schema.optional(SecretValueSchema),
  model: Schema.optional(Schema.String),
  telemetry: AgentHarnessTelemetrySchema,
  config: Schema.Record(Schema.String, Schema.Unknown),
});

export const ClaudeHarnessSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  apiKey: Schema.optional(SecretValueSchema),
  model: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.String)),
  permissions: Schema.optional(Schema.String),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      path: Schema.optional(Schema.String),
      capturePayloads: Schema.optional(Schema.Boolean),
    }),
  ),
  config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export const ClaudeHarnessSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["claude"]),
  apiKey: Schema.optional(SecretValueSchema),
  model: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.String)),
  permissions: Schema.optional(Schema.String),
  telemetry: AgentHarnessTelemetrySchema,
  config: Schema.Record(Schema.String, Schema.Unknown),
});

const LlmProviderOptionValueSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  SecretValueSchema,
  Schema.Undefined,
]);

export const LlmProviderSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  npm: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Record(Schema.String, LlmProviderOptionValueSchema)),
  models: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ name: Schema.optional(Schema.String) })),
  ),
});

export const EndpointCredentialsSchema = Schema.Record(Schema.String, SecretValueSchema);

export const EndpointSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  credentials: Schema.optional(EndpointCredentialsSchema),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export const ProviderSpecSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.String.check(Schema.isMinLength(1)),
  url: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  mcpUrl: Schema.optional(Schema.String),
  authHeader: Schema.optional(Schema.String),
  authScheme: Schema.optional(Schema.String),
  authCredential: Schema.optional(Schema.String),
  credentials: Schema.optional(EndpointCredentialsSchema),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export const VolumeCredentialsSchema = Schema.Record(Schema.String, SecretValueSchema);

const VolumeSpecFields = {
  name: Schema.String.check(Schema.isMinLength(1)),
  target: Schema.String.check(Schema.isMinLength(1)),
  prefix: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  export: Schema.optional(Schema.String),
  vendor: Schema.optional(Schema.String),
  credentials: Schema.optional(VolumeCredentialsSchema),
  options: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  proxy: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  allowedPaths: Schema.optional(Schema.Array(Schema.String)),
};

export const VolumeSpecSchema = Schema.Union([
  Schema.Struct({ ...VolumeSpecFields, type: Schema.Literal("local"), source: Schema.String }),
  Schema.Struct({ ...VolumeSpecFields, type: Schema.Literal("s3"), bucket: Schema.String }),
  Schema.Struct({ ...VolumeSpecFields, type: Schema.Literal("gcs"), bucket: Schema.String }),
  Schema.Struct({
    ...VolumeSpecFields,
    type: Schema.Literal("azure"),
    account: Schema.String,
    container: Schema.String,
    path: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...VolumeSpecFields,
    type: Schema.Literal("sftp"),
    host: Schema.String,
    path: Schema.String,
  }),
  Schema.Struct({
    ...VolumeSpecFields,
    type: Schema.Literal("smb"),
    host: Schema.String,
    share: Schema.String,
  }),
  Schema.Struct({
    ...VolumeSpecFields,
    type: Schema.Literal("webdav"),
    url: Schema.String,
    path: Schema.optional(Schema.String),
  }),
  Schema.Struct({ ...VolumeSpecFields, type: Schema.Literal("dropbox"), path: Schema.String }),
  Schema.Struct({ ...VolumeSpecFields, type: Schema.Literal("gdrive"), path: Schema.String }),
]);

export const EnvScopeSchema = Schema.Literals(["build", "runtime", "both"]);

// Input spec for addEnv. Exactly one of `value` (literal) or `from` (host
// passthrough) must be provided; addEnv enforces that XOR at runtime.
const EnvReferenceSchema = Schema.Struct({
  env: Schema.String.check(Schema.isMinLength(1)).check(
    Schema.makeFilter((value) =>
      ENV_VAR_NAME_PATTERN.test(value) ? undefined : "must be a valid environment variable name",
    ),
  ),
});

export const EnvSpecSchema = Schema.Struct({
  value: Schema.optional(Schema.String),
  from: Schema.optional(EnvReferenceSchema),
  scope: Schema.optional(EnvScopeSchema),
  required: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.String),
}).pipe(
  Schema.check(
    Schema.makeFilter((spec) => {
      const hasValue = spec.value !== undefined;
      const hasFrom = spec.from !== undefined;
      if (hasValue === hasFrom) return "provide exactly one of 'value' or 'from'";
      if (hasFrom && spec.scope === "build") return "passthrough variables cannot be build-scoped";
      if (hasValue && (spec.required || spec.default !== undefined)) {
        return "required and default only apply to passthrough variables";
      }
      return undefined;
    }),
  ),
);

// Normalized EnvVar as stored on the plan (round-trippable in plan.json).
export const EnvVarSchema = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  scope: EnvScopeSchema,
  value: Schema.optional(Schema.String),
  from: Schema.optional(Schema.Struct({ env: Schema.String })),
  required: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.String),
});

export const McpConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.optional(Schema.Number),
  token: Schema.optional(SecretValueSchema),
  allowExec: Schema.optional(Schema.Boolean),
  allowProcessControl: Schema.optional(Schema.Boolean),
  maxReadBytes: Schema.optional(Schema.Number),
  maxWriteBytes: Schema.optional(Schema.Number),
  maxListEntries: Schema.optional(Schema.Number),
});

export const ConfigSchema = Schema.Struct({
  project: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1)),
  }),
  mcp: Schema.optional(McpConfigSchema),
});

export const PortSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  host: Schema.Number,
  container: Schema.Number,
});

export const ProcessSchema = Schema.Struct({
  name: Schema.String,
  command: Schema.Array(Schema.String),
  ports: Schema.Array(PortSchema),
  environment: Schema.Record(Schema.String, Schema.String),
  workingDir: Schema.optional(Schema.String),
  healthCheck: Schema.optional(ProcessHealthCheckSpecSchema),
  mode: Schema.Literals(["daemon", "oneshot"]),
  startOn: LifecyclePointSchema,
  mergeEnv: Schema.optional(Schema.Boolean),
});

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
    }),
  ),
  networks: Schema.Array(Schema.String),
});

export const ProviderSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  url: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  mcpUrl: Schema.optional(Schema.String),
  authHeader: Schema.optional(Schema.String),
  authScheme: Schema.optional(Schema.String),
  authCredential: Schema.optional(Schema.String),
  credentials: Schema.optional(EndpointCredentialsSchema),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const TargetNameSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(
    Schema.makeFilter((value): string | undefined => {
      try {
        validateTargetName(value);
        return undefined;
      } catch (e) {
        return (e as Error).message;
      }
    }),
  ),
);

const DurationSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value): string | undefined => {
      try {
        parseDuration(value);
        return undefined;
      } catch (e) {
        return (e as Error).message;
      }
    }),
  ),
);

const CleanupSchema = Schema.Literals(["always", "on-success", "never"]);

export const RuntimeTargetSchema = Schema.Struct({
  name: TargetNameSchema,
  driver: Schema.String.check(Schema.isMinLength(1)),
  options: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.check(
      Schema.makeFilter((value) =>
        isJsonSafeValue(value) ? undefined : "must contain only JSON-safe values",
      ),
    ),
  ),
});

export const TaskSpecSchema = Schema.Struct({
  harness: Schema.String.check(Schema.isMinLength(1)),
  prompt: Schema.String.check(Schema.isMinLength(1)),
  artifacts: Schema.optional(Schema.Array(Schema.String)),
  timeout: Schema.optional(DurationSchema),
  cleanup: Schema.optional(CleanupSchema),
});

export const TaskSchema = Schema.Struct({
  name: Schema.String,
  harness: Schema.String,
  prompt: Schema.String,
  artifacts: Schema.Array(Schema.String),
  timeout: Schema.String,
  cleanup: CleanupSchema,
});

export const DeploymentPlanSchema = Schema.Struct({
  target: RuntimeTargetSchema,
  task: Schema.optional(TaskSchema),
  deploymentId: Schema.String,
});

export const LanguageRequestSchema = Schema.Struct({
  name: Schema.String,
  options: LanguageOptionsSchema,
});

export const DependencyInstallSchema = Schema.Struct({
  files: Schema.Array(Schema.String),
  command: Schema.String,
});

export const CopyArtifactSchema = Schema.Struct({
  files: Schema.Array(Schema.String),
  lines: Schema.Array(Schema.String),
});

export const NormalizedMcpConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.Number,
  token: Schema.optional(SecretValueSchema),
  allowExec: Schema.Boolean,
  allowProcessControl: Schema.Boolean,
  maxReadBytes: Schema.Number,
  maxWriteBytes: Schema.Number,
  maxListEntries: Schema.Number,
});

export const BuildPlanSchema = Schema.Struct({
  project: Schema.String,
  baseImage: Schema.String,
  aptPackages: Schema.Array(Schema.String),
  runtimeInstalls: Schema.Array(Schema.String),
  languageSnippets: Schema.Array(Schema.String),
  languageRequests: Schema.Array(LanguageRequestSchema),
  dependencyFiles: Schema.Array(Schema.String),
  dependencyInstalls: Schema.Array(DependencyInstallSchema),
  copyArtifacts: Schema.Array(CopyArtifactSchema),
  environment: Schema.Record(Schema.String, Schema.String),
  nodeModulesVolume: Schema.Boolean,
  venvVolume: Schema.Boolean,
  vendorVolume: Schema.Boolean,
  mcpEnabled: Schema.Boolean,
  mcpPort: Schema.Number,
  mcpConfig: NormalizedMcpConfigSchema,
});

export const NetworkSchema = Schema.Struct({ name: Schema.String, driver: Schema.String });
export const NamedVolumeSchema = Schema.Struct({ name: Schema.String });
export const VolumeMappingSchema = Schema.Struct({ host: Schema.String, container: Schema.String });
export const HealthCheckSchema = Schema.Struct({
  test: Schema.Array(Schema.String),
  interval: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.String),
  retries: Schema.optional(Schema.Number),
  startPeriod: Schema.optional(Schema.String),
});

export const VolumeSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals([
    "local",
    "s3",
    "gcs",
    "azure",
    "sftp",
    "smb",
    "webdav",
    "dropbox",
    "gdrive",
  ]),
  source: Schema.optional(Schema.String),
  target: Schema.String,
  bucket: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  container: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  export: Schema.optional(Schema.String),
  share: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  vendor: Schema.optional(Schema.String),
  credentials: Schema.optional(VolumeCredentialsSchema),
  options: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  proxy: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  allowedPaths: Schema.optional(Schema.Array(Schema.String)),
});

export const LlmProviderSchema = Schema.Struct({
  name: Schema.String,
  npm: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  options: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, SecretValueSchema]),
  ),
  models: Schema.Record(Schema.String, Schema.Struct({ name: Schema.optional(Schema.String) })),
});

export const RuntimePlanSchema = Schema.Struct({
  services: Schema.Array(ServiceSchema),
  networks: Schema.Array(NetworkSchema),
  namedVolumes: Schema.Array(NamedVolumeSchema),
  volumes: Schema.Array(VolumeSchema),
  ports: Schema.Array(PortSchema),
  environment: Schema.Record(Schema.String, Schema.String),
  processes: Schema.Array(ProcessSchema),
  endpoints: Schema.Array(EndpointSpecSchema),
  providers: Schema.Array(ProviderSchema),
  envVars: Schema.Array(EnvVarSchema),
  repos: Schema.Array(RepoSchema),
  agentHarnesses: Schema.Array(AgentHarnessSchema),
  piHarnesses: Schema.Array(PiHarnessSchema),
  codexHarnesses: Schema.Array(CodexHarnessSchema),
  claudeHarnesses: Schema.Array(ClaudeHarnessSchema),
  llmProviders: Schema.Array(LlmProviderSchema),
});

export const PlanSchema = Schema.Struct({
  project: Schema.String,
  deployment: Schema.optional(DeploymentPlanSchema),
  build: BuildPlanSchema,
  runtime: RuntimePlanSchema,
});
