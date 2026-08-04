import { accessSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createPlan } from "../../core/plan.js";
import type { RuntimeTarget } from "../../core/plan.js";
import {
  renderCommonArtifacts,
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
      ...files.map((file) => file.relativePath).sort(),
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

  it("rejects traversal and invalid content/source combinations", () => {
    const outputDir = makeOutputDir();
    try {
      expect(() =>
        Effect.runSync(writeArtifacts(outputDir, [{ relativePath: "../escape", content: "no" }])),
      ).toThrow(/traversal/);
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
        executionRoleArn: "arn:aws:iam::123:role/execution",
        subnets: ["subnet-1"],
      },
    };
    const plan = createPlan("artifacts");
    const outputDir = runtimeLayout(rootDir, "shared").host.root;

    try {
      const composeFiles = Effect.runSync(
        dockerComposeDriver.render({ rootDir, outputDir, plan, target: composeTarget }),
      );
      rmSync(join(rootDir, ".biodome-build"), { recursive: true, force: true });
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
