import { type RuntimeDriverId, type TaskSpec } from "./plan.js";
import type { SecretReference } from "./secrets.js";

export type { TaskSpec };
export type { SecretReference };
import type {
  ProcessSpecSchema,
  HookSpecSchema,
  LanguageOptionsSchema,
  PackageOptionsSchema,
  ToolOptionsSchema,
  ServiceOptionsSchema,
  EndpointSpecSchema,
  ProviderSpecSchema,
  EnvSpecSchema,
  VolumeSpecSchema,
  RepoSpecSchema,
  AgentHarnessSpecSchema,
  PiHarnessSpecSchema,
  CodexHarnessSpecSchema,
  ClaudeHarnessSpecSchema,
  LlmProviderSpecSchema,
} from "./plan.js";

export type ProcessSpec = typeof ProcessSpecSchema.Type;
export type HookSpec = typeof HookSpecSchema.Type;
export type LanguageOptions = typeof LanguageOptionsSchema.Type;
export type PackageOptions = typeof PackageOptionsSchema.Type;
export type ToolOptions = typeof ToolOptionsSchema.Type;
export type ServiceOptions = typeof ServiceOptionsSchema.Type;
export type EndpointSpec = typeof EndpointSpecSchema.Type;
export type ProviderSpec = typeof ProviderSpecSchema.Type;
export type EnvSpec = typeof EnvSpecSchema.Type;
export type VolumeSpec = typeof VolumeSpecSchema.Type;
export type RepoSpec = typeof RepoSpecSchema.Type;
export type AgentHarnessSpec = typeof AgentHarnessSpecSchema.Type;
export type PiHarnessSpec = typeof PiHarnessSpecSchema.Type;
export type CodexHarnessSpec = typeof CodexHarnessSpecSchema.Type;
export type ClaudeHarnessSpec = typeof ClaudeHarnessSpecSchema.Type;
export type LlmProviderSpec = typeof LlmProviderSpecSchema.Type;

// A non-credential value that may be supplied literally or via an environment
// reference. Credential-bearing fields should use `SecretReference` directly.
export type SecretValue = string | SecretReference;

export interface LocalVolumeSpec {
  name: string;
  source: string;
  target: string;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface S3VolumeSpec {
  name: string;
  bucket: string;
  prefix?: string;
  target: string;
  credentials: {
    accessKeyId?: SecretReference;
    secretAccessKey?: SecretReference;
    region?: SecretReference;
    sessionToken?: SecretReference;
    endpoint?: SecretReference;
  };
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface GcsVolumeSpec {
  name: string;
  bucket: string;
  prefix?: string;
  target: string;
  credentials: {
    clientId?: SecretReference;
    clientSecret?: SecretReference;
    token?: SecretReference;
    serviceAccountFile?: SecretReference;
    projectNumber?: SecretReference;
  };
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface AzureVolumeSpec {
  name: string;
  account: string;
  container: string;
  path?: string;
  target: string;
  credentials: {
    accountKey?: SecretReference;
    sasUrl?: SecretReference;
  };
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface SftpVolumeSpec {
  name: string;
  host: string;
  port?: number;
  path: string;
  target: string;
  credentials: {
    user?: SecretReference;
    password?: SecretReference;
    keyFile?: SecretReference;
  };
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface SmbVolumeSpec {
  name: string;
  host: string;
  share: string;
  target: string;
  credentials: {
    user?: SecretReference;
    password?: SecretReference;
    domain?: SecretReference;
  };
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface WebdavVolumeSpec {
  name: string;
  url: string;
  path?: string;
  target: string;
  credentials?: {
    user?: SecretReference;
    password?: SecretReference;
    bearerToken?: SecretReference;
  };
  vendor?: string;
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface DropboxVolumeSpec {
  name: string;
  path: string;
  target: string;
  credentials: { token?: SecretReference };
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface GdriveVolumeSpec {
  name: string;
  path: string;
  target: string;
  credentials: {
    clientId?: SecretReference;
    clientSecret?: SecretReference;
    token?: SecretReference;
  };
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface McpProviderSpec {
  name: string;
  type: string;
  mcpUrl: string;
  credentials: { token: SecretReference };
  authHeader?: string;
  authScheme?: string;
  project?: string;
  metadata?: Record<string, string>;
}

export interface JiraProviderSpec {
  name: string;
  mcpUrl?: string;
  project?: string;
  credentials: { token: SecretReference };
  metadata?: Record<string, string>;
}

export interface LinearProviderSpec {
  name: string;
  mcpUrl?: string;
  team?: string;
  credentials: { token: SecretReference };
  metadata?: Record<string, string>;
}

export interface SentryProviderSpec {
  name: string;
  mcpUrl?: string;
  credentials: { token: SecretReference };
  metadata?: Record<string, string>;
}

export interface SlackProviderSpec {
  name: string;
  mcpUrl: string;
  credentials: { token: SecretReference };
  metadata?: Record<string, string>;
}

export interface GithubProviderSpec {
  name: string;
  mcpUrl?: string;
  credentials: { token: SecretReference };
  metadata?: Record<string, string>;
}

export interface Feature {
  name: string;
  type: string;
  contribute(ctx: FeatureContext): void;
}

export interface FeatureContext {
  addProcess(spec: ProcessSpec): void;
  addHook(spec: HookSpec): void;

  addLanguage(name: string, options?: LanguageOptions): void;
  addPackage(manager: string, name: string, options?: PackageOptions): void;
  addTool(name: string, options?: ToolOptions): void;
  addService(name: string, options?: ServiceOptions): void;
  addEndpoint(spec: EndpointSpec): void;
  addProvider(spec: ProviderSpec): void;
  addMcpProvider(spec: McpProviderSpec): void;
  addJiraProvider(spec: JiraProviderSpec): void;
  addLinearProvider(spec: LinearProviderSpec): void;
  addSentryProvider(spec: SentryProviderSpec): void;
  addSlackProvider(spec: SlackProviderSpec): void;
  addGithubProvider(spec: GithubProviderSpec): void;

  addEnv(key: string, spec: EnvSpec): void;
  addVolume(spec: VolumeSpec): void;
  addRepo(spec: RepoSpec): void;
  addOpencodeHarness(spec: AgentHarnessSpec): void;
  addPiHarness(spec: PiHarnessSpec): void;
  addCodexHarness(spec: CodexHarnessSpec): void;
  addClaudeHarness(spec: ClaudeHarnessSpec): void;
  addLlmProvider(spec: LlmProviderSpec): void;

  // Volume wrappers for a simpler DX.
  addLocalVolume(spec: LocalVolumeSpec): void;
  addS3Volume(spec: S3VolumeSpec): void;
  addGcsVolume(spec: GcsVolumeSpec): void;
  addAzureVolume(spec: AzureVolumeSpec): void;
  addSftpVolume(spec: SftpVolumeSpec): void;
  addSmbVolume(spec: SmbVolumeSpec): void;
  addWebdavVolume(spec: WebdavVolumeSpec): void;
  addDropboxVolume(spec: DropboxVolumeSpec): void;
  addGdriveVolume(spec: GdriveVolumeSpec): void;

  fileExists(path: string): boolean;
  readFile(path: string): string;
  readJSON(path: string): unknown;
  exec(command: string): { stdout: string; stderr: string; exitCode: number };
}

export interface TargetContext {
  useRuntime(driver: RuntimeDriverId, options?: Record<string, unknown>): void;
}

export interface TaskContext {
  addTask(spec: TaskSpec): void;
}
