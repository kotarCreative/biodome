import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { SandboxContext } from "../core/context.js";
import { Plan } from "../core/plan.js";

const SANDBOX_DIR = "sandbox";

export interface Config {
  project: {
    name: string;
  };
}

export function buildPlan(rootDir: string): Plan {
  const config = readConfig(rootDir);
  const ctx = new SandboxContext(rootDir, config.project.name);

  loadServices(rootDir, ctx);
  loadFeatures(rootDir, ctx);

  return ctx.plan;
}

function readConfig(rootDir: string): Config {
  const path = join(rootDir, SANDBOX_DIR, "config.json");
  if (!existsSync(path)) {
    throw new Error(`Missing sandbox config file: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Config;
}

function loadServices(rootDir: string, ctx: SandboxContext): void {
  const path = join(rootDir, SANDBOX_DIR, "services.js");
  if (!existsSync(path)) {
    return;
  }
  const source = readFileSync(path, "utf-8");
  executeFeatureScript(path, source, ctx);
}

function loadFeatures(rootDir: string, ctx: SandboxContext): void {
  const featuresDir = join(rootDir, SANDBOX_DIR, "features");
  if (!existsSync(featuresDir)) {
    return;
  }

  const files = readdirSync(featuresDir)
    .filter((f) => f.endsWith(".js"))
    .sort();

  for (const file of files) {
    const path = join(featuresDir, file);
    const source = readFileSync(path, "utf-8");
    executeFeatureScript(path, source, ctx);
  }
}

function executeFeatureScript(path: string, source: string, ctx: SandboxContext): void {
  const sandbox = {
    ctx: () => ctx,
  };

  try {
    runInNewContext(source, { sandbox, console }, {
      filename: path,
      displayErrors: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load feature ${path}: ${message}`);
  }
}
