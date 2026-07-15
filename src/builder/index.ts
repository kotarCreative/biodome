import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SandboxContext } from "../core/context.js";
import { Plan } from "../core/plan.js";

const SANDBOX_DIR = "sandbox";

export interface Config {
  project: {
    name: string;
  };
}

export interface BuildPlanOptions {
  dryRun?: boolean;
}

export async function buildPlan(rootDir: string, options: BuildPlanOptions = {}): Promise<Plan> {
  const config = readConfig(rootDir);
  const ctx = new SandboxContext(rootDir, config.project.name, options.dryRun);

  await loadServices(rootDir, ctx);
  await loadFeatures(rootDir, ctx);

  return ctx.plan;
}

export function validateConfig(rootDir: string): Config {
  return readConfig(rootDir);
}

function readConfig(rootDir: string): Config {
  const path = join(rootDir, SANDBOX_DIR, "config.json");
  if (!existsSync(path)) {
    throw new Error(`Missing sandbox config file: ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid sandbox config file ${path}: ${message}`);
  }

  return validateConfigShape(raw, path);
}

function validateConfigShape(value: unknown, path: string): Config {
  if (value === null || typeof value !== "object") {
    throw new Error(`Invalid sandbox config file ${path}: expected a JSON object`);
  }

  const config = value as Record<string, unknown>;
  if (!config.project || typeof config.project !== "object") {
    throw new Error(`Invalid sandbox config file ${path}: missing required field "project"`);
  }

  const project = config.project as Record<string, unknown>;
  if (typeof project.name !== "string" || project.name.length === 0) {
    throw new Error(
      `Invalid sandbox config file ${path}: "project.name" must be a non-empty string`
    );
  }

  return { project: { name: project.name } };
}

async function loadServices(rootDir: string, ctx: SandboxContext): Promise<void> {
  for (const name of ["services.mjs", "services.js"]) {
    const path = join(rootDir, SANDBOX_DIR, name);
    if (existsSync(path)) {
      await executeFeatureModule(path, ctx);
      return;
    }
  }
}

async function loadFeatures(rootDir: string, ctx: SandboxContext): Promise<void> {
  const featuresDir = join(rootDir, SANDBOX_DIR, "features");
  if (!existsSync(featuresDir)) {
    return;
  }

  const files = readdirSync(featuresDir)
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
    .sort();

  for (const file of files) {
    const path = join(featuresDir, file);
    await executeFeatureModule(path, ctx);
  }
}

async function executeFeatureModule(path: string, ctx: SandboxContext): Promise<void> {
  const url = pathToFileURL(path).href;
  try {
    const mod = (await import(url)) as { default?: (ctx: SandboxContext) => void | Promise<void> };
    if (typeof mod.default !== "function") {
      throw new Error(
        `Feature module ${path} must export a default function that accepts the sandbox context`
      );
    }
    await mod.default(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load feature ${path}: ${message}`);
  }
}
