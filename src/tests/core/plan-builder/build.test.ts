import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { BuildBuilder } from "../../../core/plan-builder/build.js";

function makeBuilder(files: string[] = []) {
  const plan = createPlan("test");
  return { plan, builder: new BuildBuilder(plan, (path) => files.includes(path)) };
}

describe("BuildBuilder", () => {
  it("uses the neutral base image when no languages are requested", () => {
    const { builder, plan } = makeBuilder();
    builder.finalize();

    expect(plan.build.baseImage).toBe("debian:12-slim");
    expect(plan.build.runtimeInstalls).toEqual([]);
  });

  it("uses a single language base image and installs its dependencies only", () => {
    const { builder, plan } = makeBuilder(["package.json", "package-lock.json"]);
    builder.addLanguage("node", { version: "20" });
    builder.finalize();

    expect(plan.build.baseImage).toBe("node:20-slim");
    expect(plan.build.runtimeInstalls).toEqual([]);
    expect(plan.build.dependencyFiles).toEqual(["package.json", "package-lock.json"]);
    expect(plan.build.dependencyInstalls[0].command).toContain("npm ci");
    expect(plan.build.nodeModulesVolume).toBe(true);
  });

  it("uses the neutral base and installs requested runtimes in declaration order", () => {
    const { builder, plan } = makeBuilder(["requirements.txt", "go.mod"]);
    builder.addLanguage("python", { version: "3.12" });
    builder.addLanguage("go", { version: "1.22" });
    builder.finalize();

    expect(plan.build.baseImage).toBe("debian:12-slim");
    expect(plan.build.runtimeInstalls).toHaveLength(2);
    expect(plan.build.runtimeInstalls[0]).toContain("pyenv");
    expect(plan.build.runtimeInstalls[1]).toContain("go.dev");
    expect(plan.build.dependencyFiles).toEqual(["requirements.txt", "go.mod"]);
  });

  it("keeps language order while replacing options and ignores unknown languages", () => {
    const { builder, plan } = makeBuilder();
    builder.addLanguage("python", { version: "3.11" });
    builder.addLanguage("node", { version: "20" });
    builder.addLanguage("python", { version: "3.12" });
    builder.addLanguage("unknown");
    builder.finalize();

    expect(plan.build.languageRequests).toEqual([
      { name: "python", options: { version: "3.12" } },
      { name: "node", options: { version: "20" } },
    ]);
    expect(plan.build.runtimeInstalls[0]).toContain("pyenv install -s 3.12");
  });

  it("detects dependency files once in caller order and propagates file lookup failures", () => {
    const { builder, plan } = makeBuilder(["package.json", "package-lock.json"]);
    expect(builder.requireDependencyFiles(["package.json", "package-lock.json"])).toEqual([
      "package.json",
      "package-lock.json",
    ]);
    expect(builder.requireDependencyFiles(["package-lock.json", "package.json"])).toEqual([
      "package-lock.json",
      "package.json",
    ]);
    expect(plan.build.dependencyFiles).toEqual(["package.json", "package-lock.json"]);

    const failing = new BuildBuilder(createPlan("test"), () => {
      throw new Error("lookup failed");
    });
    expect(() => failing.requireDependencyFiles(["package.json"])).toThrow("lookup failed");
  });

  it.each([
    [
      "npm",
      "eslint",
      { version: "9", indexUrl: "https://registry.example" },
      "npm install -g --registry https://registry.example eslint@9",
    ],
    [
      "pip",
      "ruff",
      { version: "0.8", indexUrl: "https://pypi.example" },
      "pip install --no-cache-dir --index-url https://pypi.example ruff==0.8",
    ],
    ["cargo", "ripgrep", {}, "cargo install ripgrep"],
    ["go", "golang.org/x/tools/gopls", {}, "go install golang.org/x/tools/gopls@latest"],
    ["gem", "rubocop", {}, "gem install rubocop"],
  ])("formats %s package installs", (manager, name, options, command) => {
    const { builder, plan } = makeBuilder();
    builder.addPackage(manager, name, options);

    expect(plan.build.languageSnippets).toEqual([`RUN ${command}`]);
  });

  it("rejects invalid packages and unknown package managers", () => {
    const { builder } = makeBuilder();
    expect(() => builder.addPackage("npm", "")).toThrow("Package requires a non-empty string name");
    expect(() => builder.addPackage("brew", "jq")).toThrow("Unknown package manager brew");
  });

  it("uses tool handlers and treats unknown tools as apt packages", () => {
    const { builder, plan } = makeBuilder();
    builder.addTool("gh");
    builder.addTool("curl");
    builder.addTool("curl");

    expect(plan.build.aptPackages).toEqual(["gh", "curl"]);
    expect(plan.build.languageSnippets).toEqual(["RUN gh --version"]);
    expect(() => builder.addTool("")).toThrow("Tool requires a non-empty string name");
  });

  it("deduplicates idempotent contributions while retaining append-only ones", () => {
    const { builder, plan } = makeBuilder();
    builder.addAptPackage("git");
    builder.addAptPackage("git");
    builder.addRuntimeInstall("RUN install runtime");
    builder.addRuntimeInstall("RUN install runtime");
    builder.addLanguageSnippet("RUN install snippet");
    builder.addLanguageSnippet("RUN install snippet");
    builder.addDependencyInstall({ files: ["a"], command: "RUN one" });
    builder.addDependencyInstall({ files: ["a"], command: "RUN one" });
    builder.addCopyArtifact({ files: ["a"], lines: ["COPY a"] });
    builder.addCopyArtifact({ files: ["a"], lines: ["COPY a"] });
    builder.enableNodeModulesVolume();
    builder.enableVenvVolume();
    builder.enableVendorVolume();

    expect(plan.build.aptPackages).toEqual(["git"]);
    expect(plan.build.runtimeInstalls).toEqual(["RUN install runtime"]);
    expect(plan.build.languageSnippets).toEqual(["RUN install snippet"]);
    expect(plan.build.dependencyInstalls).toHaveLength(2);
    expect(plan.build.copyArtifacts).toHaveLength(2);
    expect(plan.build.nodeModulesVolume).toBe(true);
    expect(plan.build.venvVolume).toBe(true);
    expect(plan.build.vendorVolume).toBe(true);
  });
});
