import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../core/errors.js";
import { APP_RECIPE_API_VERSION } from "./types.js";

export interface NpmRunner {
  run(args: string[], cwd: string): void;
}

interface ParsedAppPackageSpec {
  name: string;
  selector?: string;
}

const defaultRunner: NpmRunner = {
  run(args, cwd) {
    execFileSync("npm", args, { cwd, stdio: "inherit" });
  },
};

function biodomeDir(rootDir: string): string {
  return join(rootDir, ".biodome");
}

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const semverIdentifierPattern = "(?:0|[1-9]\\d*)";
const semverPartPattern = `(?:${semverIdentifierPattern}|[xX])`;
const semverCorePattern = `${semverPartPattern}(?:\\.${semverPartPattern}){0,2}`;
const semverPrereleasePattern = "(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const semverBuildPattern = "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const semverRangePattern = new RegExp(
  `^(?:(?:[~^]|<=?|>=?|=)?v?${semverCorePattern}${semverPrereleasePattern}${semverBuildPattern})(?:\\|\\|(?:[~^]|<=?|>=?|=)?v?${semverCorePattern}${semverPrereleasePattern}${semverBuildPattern})*$`,
);
const npmTagPattern = /^[a-z][a-z0-9._-]*$/;
// Comparators and `||` are safe only when consumed by the semver grammar below.
// All other shell syntax is rejected before a selector reaches npm.
const unsafeSelectorPattern = /[\\\s;$`&()[\]{}!"'*?]/;

function parseAppPackageSpec(spec: string): ParsedAppPackageSpec {
  const separator = spec.startsWith("@")
    ? spec.indexOf("@", spec.indexOf("/") + 1)
    : spec.indexOf("@");
  if (separator === -1) return { name: spec };
  return { name: spec.slice(0, separator), selector: spec.slice(separator + 1) };
}

function isValidSelector(selector: string): boolean {
  if (!selector || unsafeSelectorPattern.test(selector) || selector.includes("/")) return false;
  if (/^(?:file|npm|https?|git|git\+|github|gitlab|bitbucket|ssh):/i.test(selector)) {
    return false;
  }
  return semverRangePattern.test(selector) || npmTagPattern.test(selector);
}

export function validateAppPackageSpec(spec: string): void {
  // Deliberately accept only registry package names plus semver selectors or npm tags.
  // This excludes package-manager source syntaxes (files, URLs, git, and aliases).
  const { name, selector } = parseAppPackageSpec(spec);
  if (
    !spec ||
    spec.startsWith("-") ||
    unsafeSelectorPattern.test(spec) ||
    !packageNamePattern.test(name) ||
    (selector !== undefined && !isValidSelector(selector))
  ) {
    throw new ValidationError({ message: `Invalid npm app package spec: "${spec}"` });
  }
}

function packageName(spec: string): string {
  return parseAppPackageSpec(spec).name;
}

function ensureManifest(dir: string): void {
  const path = join(dir, "package.json");
  if (existsSync(path)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ private: true, type: "module", dependencies: {} }, null, 2) + "\n",
  );
}

function ensureIgnored(rootDir: string): void {
  const path = join(rootDir, ".gitignore");
  const entry = ".biodome/node_modules/";
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!existing.split(/\r?\n/).includes(entry)) {
    writeFileSync(path, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${entry}\n`);
  }
}

function validateInstalledMetadata(dir: string, spec: string): { name: string; version: string } {
  const name = packageName(spec);
  const path = join(dir, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(path)) throw new ValidationError({ message: `npm did not install ${name}` });
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    name?: string;
    version?: string;
    biodome?: { type?: string; apiVersion?: number };
  };
  if (
    manifest.biodome?.type !== "app-recipe" ||
    manifest.biodome.apiVersion !== APP_RECIPE_API_VERSION
  ) {
    throw new ValidationError({
      message: `Package ${name} is not a compatible Biodome app recipe (expected biodome.type "app-recipe" and apiVersion ${APP_RECIPE_API_VERSION})`,
    });
  }
  return { name: manifest.name ?? name, version: manifest.version ?? "unknown" };
}

function packageManagerError(operation: string, error: unknown): ValidationError {
  return error instanceof ValidationError
    ? error
    : new ValidationError({
        message: `Failed to ${operation} app package: ${error instanceof Error ? error.message : String(error)}`,
      });
}

export function addAppPackageEffect(
  rootDir: string,
  spec: string,
  runner: NpmRunner = defaultRunner,
): Effect.Effect<{ name: string; version: string }, ValidationError> {
  return Effect.try({
    try: () => {
      validateAppPackageSpec(spec);
      const preflightDir = mkdtempSync(join(tmpdir(), "biodome-app-package-"));
      try {
        ensureManifest(preflightDir);
        runner.run(["install", "--ignore-scripts", "--no-save", spec], preflightDir);
        validateInstalledMetadata(preflightDir, spec);
      } finally {
        rmSync(preflightDir, { recursive: true, force: true });
      }
      const dir = biodomeDir(rootDir);
      ensureManifest(dir);
      ensureIgnored(rootDir);
      runner.run(["install", "--save", spec], dir);
      return validateInstalledMetadata(dir, spec);
    },
    catch: (error) => packageManagerError("install", error),
  });
}

export function removeAppPackageEffect(
  rootDir: string,
  spec: string,
  runner: NpmRunner = defaultRunner,
): Effect.Effect<void, ValidationError> {
  return Effect.try({
    try: () => {
      validateAppPackageSpec(spec);
      const dir = biodomeDir(rootDir);
      if (!existsSync(join(dir, "package.json"))) {
        throw new ValidationError({ message: "No .biodome/package.json exists" });
      }
      runner.run(["uninstall", packageName(spec)], dir);
    },
    catch: (error) => packageManagerError("remove", error),
  });
}
