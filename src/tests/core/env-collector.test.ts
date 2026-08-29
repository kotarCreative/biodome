import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectTargetEnvReferences } from "../../core/env-collector.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "env-collector-"));
}

function writeTarget(rootDir: string, name: string, content: string): void {
  const targetsDir = join(rootDir, ".biodome", "targets");
  mkdirSync(targetsDir, { recursive: true });
  writeFileSync(join(targetsDir, `${name}.mjs`), content);
}

describe("collectTargetEnvReferences", () => {
  it("returns empty array when there are no targets", async () => {
    const rootDir = tempRoot();
    try {
      mkdirSync(join(rootDir, ".biodome", "targets"), { recursive: true });
      expect(await collectTargetEnvReferences(rootDir)).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("collects env references from aws-ecs target options", async () => {
    const rootDir = tempRoot();
    try {
      writeTarget(
        rootDir,
        "aws",
        `export default function aws(ctx) {
          ctx.useRuntime("aws-ecs", {
            region: "us-east-1",
            cluster: "my-cluster",
            repository: "123.dkr.ecr.us-east-1.amazonaws.com/repo",
            executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
            taskRoleArn: { env: "ECS_TASK_ROLE_ARN" },
            artifactBucket: { env: "BIODOME_ECS_ARTIFACT_BUCKET" },
            subnets: ["subnet-a"],
            securityGroups: ["sg-a"],
            workspace: { strategy: "upload" },
          });
        }`,
      );
      const profiles = await collectTargetEnvReferences(rootDir);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({
        targetName: "aws",
        driver: "aws-ecs",
        variables: [
          { name: "ECS_EXECUTION_ROLE_ARN", required: true },
          { name: "ECS_TASK_ROLE_ARN", required: false },
          { name: "BIODOME_ECS_ARTIFACT_BUCKET", required: false },
        ],
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("ignores targets with no env references", async () => {
    const rootDir = tempRoot();
    try {
      writeTarget(
        rootDir,
        "local",
        `export default function local(ctx) {
          ctx.useRuntime("docker-compose");
        }`,
      );
      expect(await collectTargetEnvReferences(rootDir)).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("marks multiple references required if any occurrence is required", async () => {
    const rootDir = tempRoot();
    try {
      writeTarget(
        rootDir,
        "mixed",
        `export default function mixed(ctx) {
          ctx.useRuntime("aws-ecs", {
            region: "us-east-1",
            cluster: "c",
            repository: "r",
            executionRoleArn: { env: "ROLE" },
            optionalRole: { env: "ROLE" },
            subnets: ["s"],
            securityGroups: ["sg"],
            workspace: { strategy: "upload" },
          });
        }`,
      );
      const profiles = await collectTargetEnvReferences(rootDir);
      expect(profiles[0]?.variables).toEqual([
        expect.objectContaining({ name: "ROLE", required: true }),
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
