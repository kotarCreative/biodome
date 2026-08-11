import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
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
  expectedDriver: string,
): DeploymentState {
  const path = statePath(rootDir, targetName);
  if (!existsSync(path)) {
    throw new ValidationError({
      message: `No deployment state found for target "${targetName}". Run "biodome up ${targetName}" first.`,
    });
  }

  let raw: DeploymentState;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as DeploymentState;
  } catch {
    throw new ValidationError({
      message: `State file for target "${targetName}" is corrupt or not valid JSON`,
    });
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError({
      message: `State file for target "${targetName}" is corrupt or not a JSON object`,
    });
  }

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

  if (raw.target !== targetName) {
    throw new ValidationError({
      message: `State target mismatch: expected "${targetName}", got "${raw.target}"`,
    });
  }

  if (raw.driver !== expectedDriver) {
    throw new ValidationError({
      message: `State driver mismatch for target "${targetName}". Expected "${expectedDriver}", got "${raw.driver}".`,
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });

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
    unlinkSync(path);
  }
}
