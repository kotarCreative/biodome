import { describe, expect, it } from "vitest";
import { PlanBuilder } from "../../../core/plan-builder/plan-builder.js";
import type { ProjectIO } from "../../../core/plan-builder/project-io.js";

function fakeProjectIO(files: Record<string, string>): ProjectIO {
  return {
    fileExists: (path) => path in files,
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`Missing ${path}`);
      return content;
    },
    readJSON(path) {
      return JSON.parse(this.readFile(path));
    },
    exec: () => ({ stdout: "branch=main\n", stderr: "", exitCode: 0 }),
  };
}

describe("PlanBuilder", () => {
  it("uses injected project IO for manifest detection and feature reads", () => {
    const builder = new PlanBuilder(
      "/unused",
      "test",
      false,
      fakeProjectIO({ "package.json": '{"name":"test"}' }),
    );

    builder.context.addLanguage("node", { version: "20" });
    expect(builder.context.fileExists("package.json")).toBe(true);
    expect(builder.context.readJSON("package.json")).toEqual({ name: "test" });
    builder.finalize();

    expect(builder.getPlan().build.dependencyFiles).toEqual(["package.json"]);
  });

  it("keeps dry-run command execution side-effect free", () => {
    const builder = new PlanBuilder("/unused", "test", true, fakeProjectIO({}));

    expect(builder.context.exec("git branch --show-current")).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });
});
