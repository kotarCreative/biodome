import { runtimeLayout } from "./layout.js";

export function buildRoot(rootDir: string): string {
  return runtimeLayout(rootDir).host.root;
}

export function targetBuildDir(rootDir: string, targetName: string): string {
  return runtimeLayout(rootDir, targetName).host.root;
}

export function targetArtifactsDir(rootDir: string, targetName: string): string {
  return runtimeLayout(rootDir, targetName).host.artifacts;
}
