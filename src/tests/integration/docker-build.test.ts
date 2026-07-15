import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildPlan } from "../../builder/index.js";
import { generateDockerfile, generateCompose, generateSupervisordConf } from "../../docker/generator.js";

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createProject(dir: string, files: Record<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(fullPath.split("/").slice(0, -1).join("/"), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

const describeIntegration = hasDocker() ? describe : describe.skip;

describeIntegration("docker build integration", () => {
  it("builds a generated Dockerfile for a Python project with a usable venv", async () => {
    const dir = join("/tmp", "sandbox-integration-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "py-fixture" } }),
      "sandbox/services.mjs": "export default function services() {}\n",
      "sandbox/features/python.mjs": `
        export default function python(ctx) {
          ctx.addLanguage("python", { version: "3.12" });
        }
      `,
      "requirements.txt": "requests==2.32.3\n",
    });

    const imageTag = `sandbox-manager-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      writeFileSync(join(dir, ".dockerignore"), "");

      execFileSync(
        "docker",
        ["buildx", "build", "-f", ".sandbox/Dockerfile", "-t", imageTag, "."],
        { cwd: dir, stdio: "inherit" }
      );

      // The venv must be on PATH and have requests installed.
      const output = execFileSync(
        "docker",
        ["run", "--rm", imageTag, "python", "-c", "import requests; print('ok')"],
        { cwd: dir, encoding: "utf-8" }
      );
      expect(output.trim()).toBe("ok");
    } finally {
      try {
        execFileSync("docker", ["rmi", "-f", imageTag], { stdio: "ignore" });
      } catch {
        // Ignore cleanup errors.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);
  it("builds a generated Dockerfile for a node project", async () => {
    const dir = join("/tmp", "sandbox-integration-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "node-fixture" } }),
      "sandbox/services.mjs": "export default function services() {}\n",
      "sandbox/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "20" });
        }
      `,
      "package.json": JSON.stringify({ name: "node-fixture" }),
    });

    const imageTag = `sandbox-manager-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      writeFileSync(join(dir, ".dockerignore"), "");

      execFileSync(
        "docker",
        ["buildx", "build", "-f", ".sandbox/Dockerfile", "-t", imageTag, "."],
        { cwd: dir, stdio: "inherit" }
      );
    } finally {
      try {
        execFileSync("docker", ["rmi", "-f", imageTag], { stdio: "ignore" });
      } catch {
        // Ignore cleanup errors.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);

  it("generates a compose file with a healthy postgres service", async () => {
    const dir = join("/tmp", "sandbox-integration-" + Date.now());
    createProject(dir, {
      "sandbox/config.json": JSON.stringify({ project: { name: "pg-fixture" } }),
      "sandbox/services.mjs": `
        export default function services(ctx) {
          ctx.addService("postgres", { port: 5432 });
        }
      `,
      "sandbox/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "20" });
        }
      `,
      "package.json": JSON.stringify({ name: "pg-fixture" }),
    });

    const project = `sandbox-manager-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      const supervisord = generateSupervisordConf(plan);
      if (supervisord) {
        writeFileSync(join(dir, ".sandbox", "supervisord.conf"), supervisord);
      }
      writeFileSync(join(dir, ".sandbox", "docker-compose.yaml"), generateCompose(plan));

      execFileSync(
        "docker",
        ["compose", "-f", ".sandbox/docker-compose.yaml", "-p", project, "up", "-d", "--build"],
        { cwd: dir, stdio: "inherit" }
      );
    } finally {
      try {
        execFileSync(
          "docker",
          ["compose", "-f", ".sandbox/docker-compose.yaml", "-p", project, "down", "-v"],
          { cwd: dir, stdio: "ignore" }
        );
      } catch {
        // Ignore cleanup errors.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);
});
