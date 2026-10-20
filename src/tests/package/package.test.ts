import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MCP_RUNTIME_FILES } from "../../runtime/artifacts.js";

const tempDir = mkdtempSync(join(tmpdir(), "biodome-package-"));

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("published package", () => {
  it("installs and exposes only its documented public API", () => {
    const packageDir = join(tempDir, "package");
    const projectDir = join(tempDir, "consumer");
    const installedDir = join(projectDir, "node_modules", "@kotarcreative", "biodome");
    const rootDir = process.cwd();
    mkdirSync(packageDir);
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", packageDir], {
        cwd: rootDir,
        encoding: "utf8",
      }),
    ) as
      | Array<{ filename: string; files: Array<{ path: string }> }>
      | Record<string, { filename: string; files: Array<{ path: string }> }>;
    const { filename, files } = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];

    // Guards against accidentally shipping src/tests/docs; dist grows with the
    // number of generator modules but never approaches the source tree size.
    expect(files.length).toBeLessThan(260);
    expect(files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(\.opencode|src|docs\/design|test)/)]),
    );
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(MCP_RUNTIME_FILES.map((file) => `dist/${file}`)),
    );

    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "package.json"), '{"type":"module"}\n');
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--package-lock=false", join(packageDir, filename)],
      { cwd: projectDir, stdio: "pipe" },
    );

    const installedPackage = JSON.parse(
      readFileSync(join(installedDir, "package.json"), "utf8"),
    ) as {
      exports: {
        ".": { import: string; types: string };
        "./app": { import: string; types: string };
        "./recipes/computer-use": { import: string; types: string };
      };
      main: string;
      types: string;
      bin: { biodome: string };
    };
    for (const path of [
      installedPackage.exports["."].import,
      installedPackage.exports["."].types,
      installedPackage.exports["./app"].import,
      installedPackage.exports["./app"].types,
      installedPackage.exports["./recipes/computer-use"].import,
      installedPackage.exports["./recipes/computer-use"].types,
      installedPackage.main,
      installedPackage.types,
      installedPackage.bin.biodome,
    ]) {
      expect(existsSync(join(installedDir, path))).toBe(true);
    }

    const exportedNames = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        'import("@kotarcreative/biodome").then((module) => console.log(Object.keys(module).sort().join(",")))',
      ],
      {
        cwd: projectDir,
        encoding: "utf8",
      },
    ).trim();
    expect(exportedNames.split(",")).toEqual([
      "ProfileSchema",
      "buildActionPlan",
      "buildActionPlanEffect",
      "buildPlan",
      "buildPlanEffect",
      "buildTargetPlan",
      "buildTargetPlanEffect",
      "buildTaskPlan",
      "buildTaskPlanEffect",
      "listProfiles",
      "validateConfig",
      "validateConfigEffect",
      "validateFeatures",
      "validateFeaturesEffect",
      "validatePlan",
    ]);

    const appExportedNames = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        'import("@kotarcreative/biodome/app").then((module) => console.log(Object.keys(module).sort().join(",")))',
      ],
      { cwd: projectDir, encoding: "utf8" },
    ).trim();
    expect(appExportedNames).toContain("defineAppRecipe");

    const recipeExportedNames = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        'import("@kotarcreative/biodome/recipes/computer-use").then((module) => console.log(Object.keys(module).sort().join(",")))',
      ],
      { cwd: projectDir, encoding: "utf8" },
    ).trim();
    expect(recipeExportedNames.split(",")).toEqual(["COMPUTER_USE_ARTIFACTS", "computerUse"]);

    execFileSync(join(installedDir, installedPackage.bin.biodome), ["--help"], {
      cwd: projectDir,
      stdio: "pipe",
    });
  }, 120_000);
});
