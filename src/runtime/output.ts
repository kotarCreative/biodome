import { runtimeLayout } from "./layout.js";

export function targetBuildDir(rootDir: string, targetName: string): string {
  return runtimeLayout(rootDir, targetName).host.root;
}
