import { join } from "node:path";

const BUILD_DIR = ".biodome-build";

export function buildRoot(rootDir: string): string {
  return join(rootDir, BUILD_DIR);
}

export function targetBuildDir(rootDir: string, targetName: string): string {
  return join(buildRoot(rootDir), "targets", targetName);
}

export function targetArtifactsDir(rootDir: string, targetName: string): string {
  return join(targetBuildDir(rootDir, targetName), "artifacts");
}
