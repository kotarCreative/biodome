import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TargetContextImpl } from "./target-context.js";
import type { RuntimeTarget } from "./plan.js";
import { isSecretReference } from "./secrets.js";

const BIODOME_DIR = ".biodome";
const TARGETS_DIR = join(BIODOME_DIR, "targets");

export interface EnvVariableReference {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
}

export interface TargetEnvProfile {
  readonly targetName: string;
  readonly driver: string;
  readonly variables: EnvVariableReference[];
}

interface DiscoveredTarget {
  readonly targetName: string;
  readonly target: RuntimeTarget;
}

const ENV_DESCRIPTIONS: Record<
  string,
  { readonly description: string; readonly required?: boolean }
> = {
  ECS_EXECUTION_ROLE_ARN: {
    description: "IAM execution role ARN trusted by ecs-tasks.amazonaws.com",
  },
  ECS_TASK_ROLE_ARN: {
    description: "IAM task role ARN for ECS tasks (required for S3 artifact upload)",
    required: false,
  },
  BIODOME_ECS_ARTIFACT_BUCKET: {
    description: "S3 bucket where task artifacts are stored",
    required: false,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectEnvReferencesFromValue(
  value: unknown,
  found: Map<string, { required: boolean }>,
  required: boolean,
): void {
  if (!isPlainObject(value)) return;

  if (isSecretReference(value)) {
    found.set(value.env, { required: required || !found.get(value.env)?.required });
    return;
  }

  for (const entry of Object.values(value)) {
    collectEnvReferencesFromValue(entry, found, required);
  }
}

function envReferencesFromOptions(options: Record<string, unknown>): EnvVariableReference[] {
  const found = new Map<string, { required: boolean }>();
  collectEnvReferencesFromValue(options, found, true);

  return [...found.entries()].map(([name, meta]) => {
    const known = ENV_DESCRIPTIONS[name];
    const required = known?.required !== undefined ? known.required : meta.required;
    return {
      name,
      required,
      description: known?.description,
    };
  });
}

function targetFiles(rootDir: string): string[] {
  const targetsPath = join(rootDir, TARGETS_DIR);
  if (!existsSync(targetsPath)) return [];
  return readdirSync(targetsPath).filter(
    (entry) => entry.endsWith(".mjs") || entry.endsWith(".js"),
  );
}

async function loadTarget(
  rootDir: string,
  fileName: string,
): Promise<DiscoveredTarget | undefined> {
  const targetName = fileName.replace(/\.(mjs|js)$/, "");
  const targetPath = join(rootDir, TARGETS_DIR, fileName);
  const ctx = new TargetContextImpl(targetName);

  const mod = (await import(pathToFileURL(targetPath).href)) as {
    default?: (ctx: TargetContextImpl) => void | Promise<void>;
  };
  if (typeof mod.default !== "function") return undefined;

  await Promise.resolve(mod.default(ctx));
  const target = ctx.getTarget();
  return { targetName, target };
}

/**
 * Inspect every target module in `.biodome/targets` and collect the environment
 * variable references declared in target options (e.g. `{ env: "VAR" }`).
 * Returns one profile per target that declares at least one reference.
 */
export async function collectTargetEnvReferences(rootDir: string): Promise<TargetEnvProfile[]> {
  const profiles: TargetEnvProfile[] = [];
  for (const fileName of targetFiles(rootDir)) {
    const discovered = await loadTarget(rootDir, fileName);
    if (!discovered) continue;
    const variables = envReferencesFromOptions(discovered.target.options);
    if (variables.length > 0) {
      profiles.push({
        targetName: discovered.targetName,
        driver: discovered.target.driver,
        variables,
      });
    }
  }
  return profiles;
}
