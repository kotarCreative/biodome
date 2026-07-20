import { Plan } from "./plan.js"
import type {
  ProcessSpecSchema,
  HookSpecSchema,
  LanguageOptionsSchema,
  PackageOptionsSchema,
  ToolOptionsSchema,
  ServiceOptionsSchema,
  EndpointSpecSchema,
  EnvSpecSchema,
  VolumeSpecSchema,
} from "./plan.js"

export type ProcessSpec = typeof ProcessSpecSchema.Type
export type HookSpec = typeof HookSpecSchema.Type
export type LanguageOptions = typeof LanguageOptionsSchema.Type
export type PackageOptions = typeof PackageOptionsSchema.Type
export type ToolOptions = typeof ToolOptionsSchema.Type
export type ServiceOptions = typeof ServiceOptionsSchema.Type
export type EndpointSpec = typeof EndpointSpecSchema.Type
export type EnvSpec = typeof EnvSpecSchema.Type
export type VolumeSpec = typeof VolumeSpecSchema.Type

export type SecretValue = string | { env: string }

export interface LocalVolumeSpec {
  name: string
  source: string
  target: string
  options?: { readOnly?: "true" | "false" }
}

export interface S3VolumeSpec {
  name: string
  bucket: string
  prefix?: string
  target: string
  credentials: {
    accessKeyId: SecretValue
    secretAccessKey: SecretValue
    region?: SecretValue
    sessionToken?: SecretValue
    endpoint?: SecretValue
  }
  options?: { readOnly?: "true" | "false" }
}

export interface GcsVolumeSpec {
  name: string
  bucket: string
  prefix?: string
  target: string
  credentials: {
    clientId?: SecretValue
    clientSecret?: SecretValue
    token?: SecretValue
    serviceAccountFile?: SecretValue
    projectNumber?: SecretValue
  }
  options?: { readOnly?: "true" | "false" }
}

export interface AzureVolumeSpec {
  name: string
  account: string
  container: string
  path?: string
  target: string
  credentials: {
    accountKey?: SecretValue
    sasUrl?: SecretValue
  }
  options?: { readOnly?: "true" | "false" }
}

export interface SftpVolumeSpec {
  name: string
  host: string
  port?: number
  path: string
  target: string
  credentials: {
    user: SecretValue
    password?: SecretValue
    keyFile?: SecretValue
  }
  options?: { readOnly?: "true" | "false" }
}

export interface SmbVolumeSpec {
  name: string
  host: string
  share: string
  target: string
  credentials: {
    user?: SecretValue
    password?: SecretValue
    domain?: SecretValue
  }
  options?: { readOnly?: "true" | "false" }
}

export interface WebdavVolumeSpec {
  name: string
  url: string
  path?: string
  target: string
  credentials?: {
    user?: SecretValue
    password?: SecretValue
    bearerToken?: SecretValue
  }
  vendor?: string
  options?: { readOnly?: "true" | "false" }
}

export interface DropboxVolumeSpec {
  name: string
  path: string
  target: string
  credentials: { token: SecretValue }
  options?: { readOnly?: "true" | "false" }
}

export interface GdriveVolumeSpec {
  name: string
  path: string
  target: string
  credentials: {
    clientId: SecretValue
    clientSecret: SecretValue
    token: SecretValue
  }
  options?: { readOnly?: "true" | "false" }
}

export interface Feature {
  name: string
  type: string
  contribute(ctx: FeatureContext): void
}

export interface FeatureContext {
  plan: Plan

  addProcess(spec: ProcessSpec): void
  addHook(spec: HookSpec): void

  addLanguage(name: string, options?: LanguageOptions): void
  addPackage(manager: string, name: string, options?: PackageOptions): void
  addTool(name: string, options?: ToolOptions): void
  addService(name: string, options?: ServiceOptions): void
  addEndpoint(spec: EndpointSpec): void

  addEnv(key: string, spec: EnvSpec): void
  addVolume(spec: VolumeSpec): void

  // Volume wrappers for a simpler DX.
  addLocalVolume(spec: LocalVolumeSpec): void
  addS3Volume(spec: S3VolumeSpec): void
  addGcsVolume(spec: GcsVolumeSpec): void
  addAzureVolume(spec: AzureVolumeSpec): void
  addSftpVolume(spec: SftpVolumeSpec): void
  addSmbVolume(spec: SmbVolumeSpec): void
  addWebdavVolume(spec: WebdavVolumeSpec): void
  addDropboxVolume(spec: DropboxVolumeSpec): void
  addGdriveVolume(spec: GdriveVolumeSpec): void

  fileExists(path: string): boolean
  readFile(path: string): string
  readJSON(path: string): unknown
  exec(command: string): { stdout: string; stderr: string; exitCode: number }
}
