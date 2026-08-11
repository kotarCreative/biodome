// Immutable build artifact manifest.
// A BuildManifest records the exact artifact a `build` operation produced so
// that later `start` and one-shot `job` operations consume the same durable
// image/digest instead of re-reading provider state or guessing references.
// It intentionally carries no secret material.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ValidationError } from "../core/errors.js";
import { targetBuildDir } from "./output.js";

export const BUILD_MANIFEST_VERSION = 1;

export interface BuildManifest {
  readonly schemaVersion: typeof BUILD_MANIFEST_VERSION;
  readonly target: string;
  readonly driver: string;
  readonly deploymentId: string;
  readonly imageRef?: string;
  readonly digest: string;
  readonly contentId: string;
  readonly createdAt: string;
  readonly provider: Readonly<Record<string, string>>;
}

export interface CreateBuildManifestInput {
  readonly target: string;
  readonly driver: string;
  readonly deploymentId: string;
  readonly imageRef?: string;
  readonly digest?: string;
  readonly contentId: string;
  readonly createdAt?: string;
  readonly provider?: Readonly<Record<string, string>>;
}

/** SHA-256 of generated build inputs, excluding mutable runtime output. */
export function directoryDigest(dir: string): string {
  const hash = createHash("sha256");
  const mutableEntries = new Set([
    "artifacts",
    "logs",
    "manifest.json",
    "manifest.json.tmp",
    "state.json",
    "state.json.tmp",
  ]);
  const walk = (current: string, parent = ""): void => {
    if (!existsSync(current)) return;
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
      if (parent === "" && mutableEntries.has(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(path, relativePath);
      } else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\n");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/** Build an immutable manifest, requiring a durable content identity. */
export function createBuildManifest(input: CreateBuildManifestInput): BuildManifest {
  if (!input.digest) {
    throw new ValidationError({
      message: "Build manifest requires an immutable content digest",
    });
  }
  return {
    schemaVersion: BUILD_MANIFEST_VERSION,
    target: input.target,
    driver: input.driver,
    deploymentId: input.deploymentId,
    imageRef: input.imageRef,
    digest: input.digest,
    contentId: input.contentId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    provider: input.provider ?? {},
  };
}

/** Derive the manifest for a driver build result, computing a content digest when absent. */
export function manifestFromBuildResult(input: {
  readonly rootDir: string;
  readonly targetName: string;
  readonly driver: string;
  readonly deploymentId: string;
  readonly buildResult: { readonly imageRef?: string; readonly digest?: string };
  readonly contentId: string;
  readonly provider?: Readonly<Record<string, string>>;
}): BuildManifest {
  const buildDir = targetBuildDir(input.rootDir, input.targetName);
  const digest = input.buildResult.digest ?? directoryDigest(buildDir);
  if (!digest) {
    throw new ValidationError({
      message: `Build for target "${input.targetName}" produced no image digest or content identity`,
    });
  }
  return createBuildManifest({
    target: input.targetName,
    driver: input.driver,
    deploymentId: input.deploymentId,
    imageRef: input.buildResult.imageRef,
    digest,
    contentId: input.contentId,
    provider: input.provider,
  });
}

export function buildManifestPath(rootDir: string, targetName: string): string {
  return join(targetBuildDir(rootDir, targetName), "manifest.json");
}

function manifestMismatch(label: string, expected: string, actual: string): ValidationError {
  return new ValidationError({
    message: `Build manifest ${label} mismatch for target: expected "${expected}", got "${actual}"`,
  });
}

/**
 * Read and identity-check a build manifest. Missing, corrupt, or mismatched
 * manifests are typed errors, never silently treated as an empty build.
 */
export function readBuildManifest(
  rootDir: string,
  targetName: string,
  expectedDeploymentId: string,
  expectedDriver: string,
): BuildManifest {
  const path = buildManifestPath(rootDir, targetName);
  if (!existsSync(path)) {
    throw new ValidationError({
      message: `No build manifest found for target "${targetName}". Run "biodome build ${targetName}" first.`,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new ValidationError({
      message: `Build manifest for target "${targetName}" is corrupt or not valid JSON`,
    });
  }

  if (!isRecord(raw) || raw.schemaVersion !== BUILD_MANIFEST_VERSION) {
    throw new ValidationError({
      message: `Build manifest for target "${targetName}" has an incompatible schema version`,
    });
  }
  if (raw.target !== targetName) {
    throw manifestMismatch("target", targetName, String(raw.target));
  }
  if (raw.driver !== expectedDriver) {
    throw manifestMismatch("driver", expectedDriver, String(raw.driver));
  }
  if (raw.deploymentId !== expectedDeploymentId) {
    throw manifestMismatch("deployment ID", expectedDeploymentId, String(raw.deploymentId));
  }
  if (typeof raw.digest !== "string" || raw.digest.length === 0) {
    throw new ValidationError({
      message: `Build manifest for target "${targetName}" is missing an immutable content digest`,
    });
  }
  if (typeof raw.contentId !== "string" || raw.contentId.length === 0) {
    throw new ValidationError({
      message: `Build manifest for target "${targetName}" is missing a content identity`,
    });
  }
  if (!isBuildManifest(raw)) {
    throw new ValidationError({
      message: `Build manifest for target "${targetName}" is missing required fields`,
    });
  }
  return raw;
}

/** Persist a build manifest atomically under the target output directory. */
export function writeBuildManifest(
  rootDir: string,
  targetName: string,
  manifest: BuildManifest,
): void {
  const path = buildManifestPath(rootDir, targetName);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function removeBuildManifest(rootDir: string, targetName: string): void {
  const path = buildManifestPath(rootDir, targetName);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isBuildManifest(
  value: Record<string, unknown>,
): value is Record<string, unknown> & BuildManifest {
  return (
    value.schemaVersion === BUILD_MANIFEST_VERSION &&
    typeof value.target === "string" &&
    typeof value.driver === "string" &&
    typeof value.deploymentId === "string" &&
    (value.imageRef === undefined || typeof value.imageRef === "string") &&
    typeof value.digest === "string" &&
    typeof value.contentId === "string" &&
    typeof value.createdAt === "string" &&
    isRecord(value.provider) &&
    Object.values(value.provider).every((item) => typeof item === "string")
  );
}
