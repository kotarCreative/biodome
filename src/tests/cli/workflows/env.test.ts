import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { Effect } from "effect";
import {
  createPromptSession,
  envConfigWorkflow,
  type PromptFn,
} from "../../../cli/workflows/env.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "env-workflow-"));
}

function writeTarget(rootDir: string, name: string, content: string): void {
  const targetsDir = join(rootDir, ".biodome", "targets");
  mkdirSync(targetsDir, { recursive: true });
  writeFileSync(join(targetsDir, `${name}.mjs`), content);
}

describe("envConfigWorkflow", () => {
  it("writes collected variables to .biodome/.env", async () => {
    const rootDir = tempRoot();
    try {
      writeTarget(
        rootDir,
        "aws",
        `export default function aws(ctx) {
          ctx.useRuntime("aws-ecs", {
            region: "us-east-1",
            cluster: "c",
            repository: "r",
            executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
            subnets: ["s"],
            securityGroups: ["sg"],
            workspace: { strategy: "upload" },
          });
        }`,
      );

      const answers: Record<string, string> = {
        ECS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/exec",
      };
      const prompt: PromptFn = (question) => {
        const name = question.split(" ")[0];
        return Promise.resolve(answers[name]);
      };
      const output = { write: () => {} } as unknown as NodeJS.WriteStream;

      const result = await Effect.runPromise(envConfigWorkflow(rootDir, { prompt, output }));

      expect(result.wrote).toBe(true);
      const content = readFileSync(join(rootDir, ".biodome", ".env"), "utf-8");
      expect(content).toContain("ECS_EXECUTION_ROLE_ARN=arn:aws:iam::123456789012:role/exec");
      expect(readFileSync(join(rootDir, ".gitignore"), "utf-8")).toBe(".env\n");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses process.env values as defaults", async () => {
    const rootDir = tempRoot();
    process.env.ECS_EXECUTION_ROLE_ARN = "arn:aws:iam::000000000000:role/default";
    try {
      writeTarget(
        rootDir,
        "aws",
        `export default function aws(ctx) {
          ctx.useRuntime("aws-ecs", {
            region: "us-east-1",
            cluster: "c",
            repository: "r",
            executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
            subnets: ["s"],
            securityGroups: ["sg"],
            workspace: { strategy: "upload" },
          });
        }`,
      );

      const prompt: PromptFn = (_question, defaultValue) => {
        expect(defaultValue).toBe("arn:aws:iam::000000000000:role/default");
        return Promise.resolve(defaultValue);
      };
      const output = { write: () => {} } as unknown as NodeJS.WriteStream;

      await Effect.runPromise(envConfigWorkflow(rootDir, { prompt, output }));
    } finally {
      delete process.env.ECS_EXECUTION_ROLE_ARN;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("filters to a single target when targetName is provided", async () => {
    const rootDir = tempRoot();
    try {
      writeTarget(
        rootDir,
        "aws",
        `export default function aws(ctx) {
          ctx.useRuntime("aws-ecs", {
            region: "us-east-1",
            cluster: "c",
            repository: "r",
            executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
            subnets: ["s"],
            securityGroups: ["sg"],
            workspace: { strategy: "upload" },
          });
        }`,
      );
      writeTarget(
        rootDir,
        "staging",
        `export default function staging(ctx) {
          ctx.useRuntime("aws-ecs", {
            region: "us-west-2",
            cluster: "c2",
            repository: "r2",
            executionRoleArn: { env: "STAGING_EXECUTION_ROLE_ARN" },
            subnets: ["s2"],
            securityGroups: ["sg2"],
            workspace: { strategy: "upload" },
          });
        }`,
      );

      const answers: Record<string, string> = {
        ECS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/exec",
      };
      const prompt: PromptFn = (question) => {
        const name = question.split(" ")[0];
        return Promise.resolve(answers[name]);
      };
      const output = { write: () => {} } as unknown as NodeJS.WriteStream;

      const result = await Effect.runPromise(
        envConfigWorkflow(rootDir, { targetName: "aws", prompt, output }),
      );

      expect(result.wrote).toBe(true);
      const content = readFileSync(join(rootDir, ".biodome", ".env"), "utf-8");
      expect(content).toContain("ECS_EXECUTION_ROLE_ARN=");
      expect(content).not.toContain("STAGING_EXECUTION_ROLE_ARN=");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("reports when no references match the requested target", async () => {
    const rootDir = tempRoot();
    try {
      writeTarget(
        rootDir,
        "local",
        `export default function local(ctx) {
          ctx.useRuntime("docker-compose");
        }`,
      );
      const output = { write: () => {} } as unknown as NodeJS.WriteStream;
      const result = await Effect.runPromise(
        envConfigWorkflow(rootDir, { targetName: "missing", output }),
      );
      expect(result.wrote).toBe(false);
      expect(result.message).toMatch(/No environment variable references found/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("createPromptSession", () => {
  it("does not echo existing or piped secret values", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rendered += chunk;
    });
    const session = createPromptSession(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.end("new-secret\n");
    await expect(session.prompt("API_TOKEN (required)", "old-secret")).resolves.toBe("new-secret");
    session.close();

    expect(rendered).toBe("API_TOKEN (required) [keep existing]: \n");
    expect(rendered).not.toContain("old-secret");
    expect(rendered).not.toContain("new-secret");
  });
});
