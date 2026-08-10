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

    expect(files.length).toBeLessThan(200);
    expect(files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(\.opencode|src|docs\/design|test)/)]),
    );
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(MCP_RUNTIME_FILES.map((file) => `dist/mcp/${file}`)),
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
      "buildPlan",
      "buildPlanEffect",
      "buildTargetPlan",
      "buildTargetPlanEffect",
      "buildTaskPlan",
      "buildTaskPlanEffect",
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

    execFileSync("node", [join(installedDir, installedPackage.bin.biodome), "--help"], {
      cwd: projectDir,
      stdio: "pipe",
    });
  }, 120_000);
});
