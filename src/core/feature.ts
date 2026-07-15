import { Plan } from "./plan.js"
import type {
  ProcessSpecSchema,
  HookSpecSchema,
  LanguageOptionsSchema,
  PackageOptionsSchema,
  ToolOptionsSchema,
  ServiceOptionsSchema,
} from "./plan.js"

export type ProcessSpec = typeof ProcessSpecSchema.Type
export type HookSpec = typeof HookSpecSchema.Type
export type LanguageOptions = typeof LanguageOptionsSchema.Type
export type PackageOptions = typeof PackageOptionsSchema.Type
export type ToolOptions = typeof ToolOptionsSchema.Type
export type ServiceOptions = typeof ServiceOptionsSchema.Type

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

  setEnv(key: string, value: string): void

  fileExists(path: string): boolean
  readFile(path: string): string
  readJSON(path: string): unknown
  exec(command: string): { stdout: string; stderr: string; exitCode: number }
}
