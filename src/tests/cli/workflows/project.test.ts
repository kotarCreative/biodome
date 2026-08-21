import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appInspectWorkflow,
  appListWorkflow,
  appValidateWorkflow,
  initWorkflow,
} from "../../../cli/workflows/project.js";

function configName(dir: string): string {
  Effect.runSync(initWorkflow(dir, true));
  const config = JSON.parse(readFileSync(join(dir, ".biodome", "config.json"), "utf8")) as {
    project: { name: string };
  };
  return config.project.name;
}

describe("initWorkflow", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "project-workflow-"));
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it("derives the project name from a POSIX path", () => {
    expect(configName(rootDir)).toMatch(/^project-workflow-/);
  });

  it("derives the project name from a Windows-style path", () => {
    const windowsStyle = `${rootDir}\\demo-project`;
    try {
      expect(configName(windowsStyle)).toBe("demo-project");
    } finally {
      rmSync(windowsStyle, { recursive: true, force: true });
    }
  });

  it("scaffolds the .biodome directory with auto-detection", () => {
    const result = Effect.runSync(initWorkflow(rootDir, false));
    expect(result.message).toContain("Initialized .biodome config");
    expect(existsSync(join(rootDir, ".biodome", "config.json"))).toBe(true);
    expect(existsSync(join(rootDir, ".biodome", "services.mjs"))).toBe(true);
    expect(existsSync(join(rootDir, ".biodome", "features", "auto-detect.mjs"))).toBe(true);
    expect(existsSync(join(rootDir, ".biodome", "targets", "local.mjs"))).toBe(true);
    expect(existsSync(join(rootDir, ".biodome", "apps", ".gitkeep"))).toBe(true);
    expect(existsSync(join(rootDir, ".biodome", "tasks", ".gitkeep"))).toBe(true);
  });

  it("creates a minimal scaffold in bare mode", () => {
    Effect.runSync(initWorkflow(rootDir, true));
    expect(existsSync(join(rootDir, ".biodome", "features", ".gitkeep"))).toBe(true);
    expect(existsSync(join(rootDir, ".biodome", "features", "auto-detect.mjs"))).toBe(false);
  });

  it("appends the build directory to a missing .gitignore", () => {
    Effect.runSync(initWorkflow(rootDir, true));
    expect(readFileSync(join(rootDir, ".gitignore"), "utf8")).toBe(".biodome-build/\n");
  });

  it("preserves an existing .gitignore without a trailing newline", () => {
    writeFileSync(join(rootDir, ".gitignore"), "node_modules");
    Effect.runSync(initWorkflow(rootDir, true));
    expect(readFileSync(join(rootDir, ".gitignore"), "utf8")).toBe(
      "node_modules\n.biodome-build/\n",
    );
  });

  it("does not duplicate an existing ignore entry", () => {
    writeFileSync(join(rootDir, ".gitignore"), "node_modules\n.biodome-build/\n");
    Effect.runSync(initWorkflow(rootDir, true));
    expect(
      readFileSync(join(rootDir, ".gitignore"), "utf8")
        .split("\n")
        .filter((line) => line === ".biodome-build/"),
    ).toHaveLength(1);
  });

  it("rejects initialization when .biodome already exists", async () => {
    Effect.runSync(initWorkflow(rootDir, true));
    await expect(Effect.runPromise(initWorkflow(rootDir, true))).rejects.toThrow(
      "Config directory .biodome already exists",
    );
  });
});

describe("application workflows", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "project-apps-"));
    const configDir = join(rootDir, ".biodome");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ project: { name: "apps" } }));
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it("lists projects without applications", async () => {
    await expect(Effect.runPromise(appListWorkflow(rootDir))).resolves.toBe(
      "No applications declared\n",
    );
  });

  it("validates a minimal project", async () => {
    await expect(Effect.runPromise(appValidateWorkflow(rootDir))).resolves.toEqual({
      message: "Applications are valid",
    });
  });

  it("reports unknown applications during inspection", async () => {
    await expect(Effect.runPromise(appInspectWorkflow(rootDir, "missing", false))).rejects.toThrow(
      /Unknown application "missing"/,
    );
  });
});
