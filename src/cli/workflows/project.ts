import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { buildPlanEffect, validatePlan } from "../../builder/index.js";
import { addAppPackageEffect, removeAppPackageEffect } from "../../apps/package-manager.js";
import { appInspection, formatAppInspection, formatAppList } from "../../apps/format.js";
import { formatAgentsMd, formatInfo } from "../../core/info.js";
import { PlanError } from "../../core/errors.js";
import { detectStarterLanguages, generateStarterFeature } from "../helpers.js";

const CONFIG_DIR = ".biodome";

export function initWorkflow(rootDir: string, bare: boolean) {
  return Effect.try({
    try: () => {
      const configDir = join(rootDir, CONFIG_DIR);
      const projectName = rootDir.split("/").pop() || "project";
      if (existsSync(configDir))
        throw new PlanError({ message: "Config directory .biodome already exists" });
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ project: { name: projectName } }, null, 2) + "\n",
      );
      writeFileSync(
        join(configDir, "services.mjs"),
        "export default function services(ctx) {\n  // Define backing services here\n}\n",
      );
      mkdirSync(join(configDir, "features"), { recursive: true });
      mkdirSync(join(configDir, "apps"), { recursive: true });
      writeFileSync(join(configDir, "apps", ".gitkeep"), "");
      writeFileSync(
        join(configDir, "features", bare ? ".gitkeep" : "auto-detect.mjs"),
        bare ? "" : generateStarterFeature(detectStarterLanguages(rootDir)),
      );
      mkdirSync(join(configDir, "targets"), { recursive: true });
      writeFileSync(
        join(configDir, "targets", "local.mjs"),
        'export default function local(ctx) {\n  ctx.useRuntime("docker-compose");\n}\n',
      );
      mkdirSync(join(configDir, "tasks"), { recursive: true });
      writeFileSync(join(configDir, "tasks", ".gitkeep"), "");
      return { message: `Initialized .biodome config for ${projectName}` };
    },
    catch: (error) =>
      error instanceof PlanError
        ? error
        : new PlanError({ message: error instanceof Error ? error.message : String(error) }),
  });
}

export function infoWorkflow(rootDir: string) {
  return Effect.map(buildPlanEffect(rootDir, { dryRun: true }), formatInfo);
}

export function appListWorkflow(rootDir: string) {
  return Effect.map(buildPlanEffect(rootDir, { dryRun: true }), formatAppList);
}

export function appInspectWorkflow(rootDir: string, name: string, json: boolean) {
  return Effect.map(buildPlanEffect(rootDir, { dryRun: true }), (plan) =>
    json ? JSON.stringify(appInspection(plan, name), null, 2) : formatAppInspection(plan, name),
  );
}

export function appValidateWorkflow(rootDir: string) {
  return Effect.gen(function* () {
    const plan = yield* buildPlanEffect(rootDir, { dryRun: true });
    yield* validatePlan(plan);
    return { message: "Applications are valid" };
  });
}

export function appAddWorkflow(rootDir: string, packageSpec: string) {
  return Effect.map(
    addAppPackageEffect(rootDir, packageSpec),
    (installed) => `Installed ${installed.name}@${installed.version}`,
  );
}

export function appRemoveWorkflow(rootDir: string, packageSpec: string) {
  return Effect.as(removeAppPackageEffect(rootDir, packageSpec), `Removed ${packageSpec}`);
}

export function agentsWorkflow(rootDir: string) {
  return Effect.map(buildPlanEffect(rootDir, { dryRun: true }), (plan) => {
    writeFileSync(join(rootDir, "AGENTS.md"), formatAgentsMd(plan));
    return { message: "Generated AGENTS.md" };
  });
}
