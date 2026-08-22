import { accessSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createPlan } from "../../core/plan.js";
import type { RuntimeTarget } from "../../core/plan.js";
import {
  renderCommonArtifacts,
  isPathWithin,
  MCP_RUNTIME_FILES,
  writeArtifacts,
  type GeneratedFile,
} from "../../runtime/artifacts.js";
import { createAwsEcsDriver } from "../../runtime/aws-ecs.js";
import { dockerComposeDriver } from "../../runtime/docker-compose.js";
import { runtimeLayout } from "../../runtime/layout.js";

function makeOutputDir(): string {
  const directory = join(tmpdir(), `biodome-artifacts-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("runtime artifacts", () => {
  it("renders a deterministic common manifest", () => {
    const plan = createPlan("artifacts");
    const layout = runtimeLayout("/project", "local");

    const files = renderCommonArtifacts(plan, layout);

    expect(files.map((file) => file.relativePath)).toEqual([
      ...files.map((file) => file.relativePath).sort((left, right) => left.localeCompare(right)),
    ]);
    expect(files).toContainEqual(
      expect.objectContaining({ relativePath: ".biodome-build/targets/local/Dockerfile" }),
    );
    expect(files).toContainEqual(expect.objectContaining({ relativePath: ".dockerignore" }));
  });

  it("writes text, copies sources, creates parents, and applies modes", () => {
    const outputDir = makeOutputDir();
    const sourcePath = join(outputDir, "source.txt");
    writeFileSync(sourcePath, "copied");
    const files: GeneratedFile[] = [
      { relativePath: "nested/script.sh", content: "#!/bin/sh\necho ok\n", mode: 0o755 },
      { relativePath: "copied.txt", sourcePath },
    ];

    try {
      const written = Effect.runSync(writeArtifacts(outputDir, files));
      expect(written).toEqual([join(outputDir, "copied.txt"), join(outputDir, "nested/script.sh")]);
      expect(readFileSync(join(outputDir, "copied.txt"), "utf-8")).toBe("copied");
      expect(readFileSync(join(outputDir, "nested/script.sh"), "utf-8")).toContain("echo ok");
      expect(statSync(join(outputDir, "nested/script.sh")).mode & 0o777).toBe(0o755);
      accessSync(join(outputDir, "nested"));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("creates a generated dockerignore only when the project does not own one", () => {
    const outputDir = makeOutputDir();
    const layout = runtimeLayout(outputDir, "local");
    const dockerignore = join(outputDir, ".dockerignore");
    const dockerignoreArtifact = renderCommonArtifacts(createPlan("artifacts"), layout).filter(
      (file) => file.relativePath === ".dockerignore",
    );

    try {
      expect(Effect.runSync(writeArtifacts(outputDir, dockerignoreArtifact))).toEqual([
        dockerignore,
      ]);
      writeFileSync(dockerignore, "project-owned\r\n");
      expect(Effect.runSync(writeArtifacts(outputDir, dockerignoreArtifact))).toEqual([]);
      expect(readFileSync(dockerignore)).toEqual(Buffer.from("project-owned\r\n"));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("skips byte-identical rewrites but still updates changed content", () => {
    const outputDir = makeOutputDir();
    const files: GeneratedFile[] = [
      { relativePath: "script.sh", content: "#!/bin/sh\necho ok\n", mode: 0o755 },
    ];

    try {
      expect(Effect.runSync(writeArtifacts(outputDir, files))).toEqual([
        join(outputDir, "script.sh"),
      ]);
      const scriptPath = join(outputDir, "script.sh");
      const firstMtime = statSync(scriptPath).mtimeMs;

      // Second render with identical content leaves the file untouched.
      expect(Effect.runSync(writeArtifacts(outputDir, files))).toEqual([]);
      expect(statSync(scriptPath).mtimeMs).toBe(firstMtime);
      expect(statSync(scriptPath).mode & 0o777).toBe(0o755);

      // Changed content is written again.
      const updated: GeneratedFile[] = [
        { relativePath: "script.sh", content: "#!/bin/sh\necho changed\n", mode: 0o755 },
      ];
      expect(Effect.runSync(writeArtifacts(outputDir, updated))).toEqual([scriptPath]);
      expect(readFileSync(scriptPath, "utf-8")).toContain("changed");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("checks output containment with platform path semantics", () => {
    expect(isPathWithin("/tmp/output", "/tmp/output/nested/file")).toBe(true);
    expect(isPathWithin("/tmp/output", "/tmp/escape")).toBe(false);
    expect(isPathWithin("/tmp/output", "/tmp/output-other/file")).toBe(false);
    expect(isPathWithin("/tmp/output", "/absolute/file")).toBe(false);
    expect(
      isPathWithin("C:\\project\\.biodome-build", "C:\\project\\.biodome-build\\Dockerfile", win32),
    ).toBe(true);
    expect(
      isPathWithin(
        "C:\\project\\.biodome-build",
        "C:\\project\\.biodome-build-other\\Dockerfile",
        win32,
      ),
    ).toBe(false);
    expect(isPathWithin("C:\\project\\.biodome-build", "D:\\escape\\Dockerfile", win32)).toBe(
      false,
    );
  });

  it("includes the complete MCP runtime tree in deterministic common artifacts", () => {
    const plan = createPlan("artifacts");
    plan.build.mcpEnabled = true;
    const layout = runtimeLayout("/project", "local");

    const files = renderCommonArtifacts(plan, layout);
    const runtimePaths = MCP_RUNTIME_FILES.map((file) => `.biodome-build/targets/local/${file}`);
    const runtimeFiles = files.filter((file) => runtimePaths.includes(file.relativePath));

    expect(files.map((file) => file.relativePath)).toEqual(
      files.map((file) => file.relativePath).sort((left, right) => left.localeCompare(right)),
    );
    expect(files).toContainEqual(
      expect.objectContaining({ relativePath: ".biodome-build/targets/local/plan.json" }),
    );
    expect(runtimeFiles.map((file) => file.relativePath)).toEqual(runtimePaths);
    expect(runtimePaths).toContain(".biodome-build/targets/local/core/redaction.js");
    expect(runtimePaths).toContain(".biodome-build/targets/local/mcp/command-runner.js");
    for (const file of runtimeFiles) {
      expect((file.content === undefined) !== (file.sourcePath === undefined)).toBe(true);
    }
  });

  it("rejects traversal and invalid content/source combinations", () => {
    const outputDir = makeOutputDir();
    try {
      expect(() =>
        Effect.runSync(writeArtifacts(outputDir, [{ relativePath: "../escape", content: "no" }])),
      ).toThrow(/traversal/);
      expect(() =>
        Effect.runSync(writeArtifacts(outputDir, [{ relativePath: "/absolute", content: "no" }])),
      ).toThrow(/non-absolute/);
      expect(() =>
        Effect.runSync(
          writeArtifacts(outputDir, [{ relativePath: "missing", content: "x", sourcePath: "y" }]),
        ),
      ).toThrow(/exactly one/);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("writes the same common artifacts for Compose and ECS", () => {
    const rootDir = makeOutputDir();
    const composeTarget: RuntimeTarget = { name: "shared", driver: "docker-compose", options: {} };
    const ecsTarget: RuntimeTarget = {
      name: "shared",
      driver: "aws-ecs",
      options: {
        region: "us-east-1",
        cluster: "test",
        repository: "example/repository",
        executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
        subnets: ["subnet-1"],
        securityGroups: ["sg-1"],
      },
    };
    const plan = createPlan("artifacts");
    const outputDir = runtimeLayout(rootDir, "shared").host.root;

    try {
      const composeFiles = Effect.runSync(
        dockerComposeDriver.render({ rootDir, outputDir, plan, target: composeTarget }),
      );
      rmSync(join(rootDir, ".biodome-build"), { recursive: true, force: true });
      rmSync(join(rootDir, ".dockerignore"), { force: true });
      const ecsFiles = Effect.runSync(
        createAwsEcsDriver().render({ rootDir, outputDir, plan, target: ecsTarget }),
      );

      const relativeFiles = (files: string[]) =>
        files.map((file) => file.slice(rootDir.length + 1));
      expect(relativeFiles(composeFiles)).toContain(
        ".biodome-build/targets/shared/docker-compose.yaml",
      );
      expect(relativeFiles(ecsFiles)).not.toContain(
        ".biodome-build/targets/shared/docker-compose.yaml",
      );
      expect(
        relativeFiles(composeFiles).filter(
          (file) => file !== ".biodome-build/targets/shared/docker-compose.yaml",
        ),
      ).toEqual(relativeFiles(ecsFiles));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
