import { Plan, DependencyInstall, CopyArtifact } from "./plan.js"

export interface BuildContext {
  plan: Plan

  setBaseImage(name: string): boolean
  requireDependencyFiles(files: string[]): string[]
  addDependencyInstall(install: DependencyInstall): void
  addCopyArtifact(artifact: CopyArtifact): void

  addAptPackage(name: string): void
  addRuntimeInstall(snippet: string): void
  addLanguageSnippet(snippet: string): void
  fileExists(path: string): boolean

  enableNodeModulesVolume(): void
  enableVenvVolume(): void
  enableVendorVolume(): void
}
