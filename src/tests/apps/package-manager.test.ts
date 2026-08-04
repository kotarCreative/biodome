import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  addAppPackageEffect,
  removeAppPackageEffect,
  validateAppPackageSpec,
  type NpmRunner,
} from "../../apps/package-manager.js";

const dirs: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "biodome-package-manager-"));
  dirs.push(value);
  return value;
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("app package manager", () => {
  it.each([
    "basic",
    "basic@1.2.3",
    "basic@^1.2.3",
    "basic@~1.2",
    "basic@>=1.0.0",
    "basic@1.x",
    "basic@1.2.3-beta.1",
    "basic@latest",
    "@scope/recipe",
    "@scope/recipe@2.0.0",
    "@scope/recipe@next-2026",
    "@scope/recipe@^2.0.0||^3.0.0",
  ])("accepts registry package spec %s", (spec) => {
    expect(() => validateAppPackageSpec(spec)).not.toThrow();
  });

  it.each([
    "",
    "-D",
    "basic@",
    "basic@file:../recipe",
    "basic@file:/tmp/recipe",
    "basic@https://example.com/recipe.tgz",
    "basic@http://example.com/recipe.tgz",
    "basic@git+https://github.com/org/recipe.git",
    "basic@git://github.com/org/recipe.git",
    "basic@github:org/recipe",
    "basic@gitlab:org/recipe",
    "basic@npm:other-recipe@1.0.0",
    "../recipe",
    "./recipe",
    "/tmp/recipe",
    "basic --save-dev",
    "basic;rm",
    "basic$(whoami)",
    "basic@*",
    "@scope/recipe@^1.0.0 extra",
    "@scope/@recipe",
    "Basic",
  ])("rejects unsafe or unsupported package spec %s", (spec) => {
    expect(() => validateAppPackageSpec(spec)).toThrow("Invalid npm app package spec");
  });

  it("uses npm argument arrays in .biodome and validates installed metadata", async () => {
    const project = root();
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runner: NpmRunner = {
      run(args, cwd) {
        calls.push({ args, cwd });
      },
    };
    const pkg = join(project, ".biodome", "node_modules", "@test", "recipe");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@test/recipe",
        version: "1.2.3",
        biodome: { type: "app-recipe", apiVersion: 1 },
      }),
    );
    await expect(
      Effect.runPromise(addAppPackageEffect(project, "@test/recipe", runner)),
    ).resolves.toEqual({
      name: "@test/recipe",
      version: "1.2.3",
    });
    expect(calls).toEqual([
      { args: ["install", "--save", "@test/recipe"], cwd: join(project, ".biodome") },
    ]);
    expect(calls[0].args.join(" ")).not.toContain(";");
  });

  it("removes only the validated package name", async () => {
    const project = root();
    mkdirSync(join(project, ".biodome"), { recursive: true });
    writeFileSync(join(project, ".biodome", "package.json"), "{}\n");
    const calls: string[][] = [];
    const runner: NpmRunner = {
      run(args) {
        calls.push(args);
      },
    };
    await Effect.runPromise(removeAppPackageEffect(project, "@scope/basic@1.0.0", runner));
    expect(calls).toEqual([["uninstall", "@scope/basic"]]);
  });

  it("maps package-manager failures to ValidationError", async () => {
    const runner: NpmRunner = {
      run() {
        throw new Error("npm unavailable");
      },
    };

    await expect(
      Effect.runPromise(addAppPackageEffect(root(), "recipe", runner)),
    ).rejects.toMatchObject({
      _tag: "ValidationError",
      message: expect.stringContaining("npm unavailable"),
    });
  });
});
