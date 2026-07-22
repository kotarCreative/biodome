import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { targetBuildDir } from "./output.js";
import { ValidationError } from "../core/errors.js";

export interface DeploymentState {
  schemaVersion: number;
  target: string;
  driver: string;
  deploymentId: string;
  createdAt: string;
  resourceIds: Record<string, string>;
}

const CURRENT_SCHEMA_VERSION = 1;

export function statePath(rootDir: string, targetName: string): string {
  return join(targetBuildDir(rootDir, targetName), "state.json");
}

export function readState(
  rootDir: string,
  targetName: string,
  expectedDeploymentId: string,
): DeploymentState {
  const path = statePath(rootDir, targetName);
  if (!existsSync(path)) {
    throw new ValidationError({
      message: `No deployment state found for target "${targetName}". Run "biodome up ${targetName}" first.`,
    });
  }

  const raw = JSON.parse(readFileSync(path, "utf-8")) as DeploymentState;

  if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new ValidationError({
      message: `State file for target "${targetName}" has incompatible schema version ${raw.schemaVersion}. Expected ${CURRENT_SCHEMA_VERSION}.`,
    });
  }

  if (raw.deploymentId !== expectedDeploymentId) {
    throw new ValidationError({
      message: `State deployment ID mismatch for target "${targetName}". Expected ${expectedDeploymentId}, got ${raw.deploymentId}. Run "biodome build ${targetName}" first.`,
    });
  }

  return raw;
}

export function writeState(
  rootDir: string,
  targetName: string,
  state: Omit<DeploymentState, "schemaVersion" | "target"> & {
    schemaVersion?: number;
    target?: string;
  },
): void {
  const path = statePath(rootDir, targetName);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const enriched: DeploymentState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    target: targetName,
    driver: state.driver,
    deploymentId: state.deploymentId,
    createdAt: state.createdAt,
    resourceIds: state.resourceIds,
  };

  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(enriched, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, path);
}

export function removeState(rootDir: string, targetName: string): void {
  const path = statePath(rootDir, targetName);
  if (existsSync(path)) {
    renameSync(path, path + ".bak");
  }
}
