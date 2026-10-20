import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { buildPlan } from "../../builder/index.js";
import { createPlan, type RuntimeTarget } from "../../core/plan.js";
import { generateCompose } from "../../docker/generators/compose.js";
import { generateDockerfile } from "../../docker/generators/dockerfile.js";
import { generateHealthcheckScripts } from "../../docker/generators/healthchecks.js";
import { generateInContainerServiceFiles } from "../../docker/generators/services.js";
import { generateStartupScript } from "../../docker/generators/startup.js";
import { generateSupervisordConf } from "../../docker/generators/supervisor.js";
import { renderCommonArtifacts, writeArtifacts } from "../../runtime/artifacts.js";
import { runtimeLayout } from "../../runtime/layout.js";

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Plan 04 maps the container's runtime identity onto the workspace bind-mount
 * owner at `up` time, so generated compose projects stay writable without the
 * container ever chowning host files.
 */
function hostIdentityEnv(): Record<string, string> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return { ...process.env, BIODOME_RUNTIME_UID: String(uid), BIODOME_RUNTIME_GID: String(gid) };
}

/** First effective uid of a supervised process, read from /proc inside dev. */
function supervisedProcessUid(
  cwd: string,
  composeFile: string,
  project: string,
  processName: string,
): string {
  const pid = execFileSync(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "-p",
      project,
      "exec",
      "-T",
      "dev",
      "supervisorctl",
      "-c",
      "/workspace/.biodome-build/supervisord.conf",
      "pid",
      processName,
    ],
    { cwd, encoding: "utf-8" },
  ).trim();
  return execFileSync(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "-p",
      project,
      "exec",
      "-T",
      "dev",
      "sh",
      "-c",
      `grep '^Uid:' /proc/${pid}/status | awk '{print $2}'`,
    ],
    { cwd, encoding: "utf-8" },
  ).trim();
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
  it("builds a self-contained ECS upload image with the AWS artifact client", () => {
    const dir = mkdtempSync(join(tmpdir(), "biodome-ecs-image-"));
    const target: RuntimeTarget = {
      name: "ecs-production",
      driver: "aws-ecs",
      options: {
        region: "us-east-1",
        cluster: "production",
        repository: "123456789012.dkr.ecr.us-east-1.amazonaws.com/app",
        executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
        subnets: ["subnet-example"],
        securityGroups: ["sg-example"],
        workspace: { strategy: "upload" },
        artifactBucket: "biodome-artifacts",
      },
    };
    const plan = {
      ...createPlan("ecs-image-fixture"),
      deployment: { target, deploymentId: "ecs-image-test" },
    };
    const layout = runtimeLayout(dir, target.name);
    const imageTag = `biodome-ecs-image-test-${Date.now()}`;

    try {
      createProject(dir, {
        "workspace-marker.txt": "uploaded workspace\n",
        ".env": "MUST_NOT_ENTER_IMAGE=secret\n",
        ".aws/credentials": "MUST_NOT_ENTER_IMAGE=secret\n",
      });
      Effect.runSync(writeArtifacts(dir, renderCommonArtifacts(plan, layout)));

      execFileSync(
        "docker",
        ["buildx", "build", "-f", layout.host.dockerfile, "-t", imageTag, "."],
        { cwd: dir, stdio: "inherit" },
      );

      const output = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          imageTag,
          "-c",
          [
            'test "$(id -u)" = 10001',
            "test \"$(cat /workspace/workspace-marker.txt)\" = 'uploaded workspace'",
            "test -f /workspace/.biodome-build/targets/ecs-production/Dockerfile",
            "test ! -e /workspace/.env",
            "test ! -e /workspace/.aws/credentials",
            "command -v aws >/dev/null",
            "touch /workspace/runtime-write-test",
            "rm /workspace/runtime-write-test",
            "printf ready",
          ].join(" && "),
        ],
        { cwd: dir, encoding: "utf-8" },
      );
      expect(output).toBe("ready");
    } finally {
      try {
        execFileSync("docker", ["rmi", "-f", imageTag], { stdio: "ignore" });
      } catch {
        // Ignore cleanup errors.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);

  it("builds a generated Dockerfile for a Python project with a usable venv", async () => {
    const dir = join("/tmp", "sandbox-integration-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "py-fixture" } }),
      ".biodome/services.mjs": "export default function services() {}\n",
      ".biodome/features/python.mjs": `
        export default function python(ctx) {
          ctx.addLanguage("python", { version: "3.12" });
        }
      `,
      "requirements.txt": "requests==2.32.3\n",
    });

    const imageTag = `biodome-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      writeFileSync(join(dir, ".dockerignore"), "");

      execFileSync(
        "docker",
        ["buildx", "build", "-f", ".sandbox/Dockerfile", "-t", imageTag, "."],
        { cwd: dir, stdio: "inherit" },
      );

      // The venv must be on PATH and have requests installed.
      const output = execFileSync(
        "docker",
        ["run", "--rm", imageTag, "python", "-c", "import requests; print('ok')"],
        { cwd: dir, encoding: "utf-8" },
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
      ".biodome/config.json": JSON.stringify({ project: { name: "node-fixture" } }),
      ".biodome/services.mjs": "export default function services() {}\n",
      ".biodome/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "20" });
        }
      `,
      "package.json": JSON.stringify({ name: "node-fixture" }),
    });

    const imageTag = `biodome-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      writeFileSync(join(dir, ".dockerignore"), "");

      execFileSync(
        "docker",
        ["buildx", "build", "-f", ".sandbox/Dockerfile", "-t", imageTag, "."],
        { cwd: dir, stdio: "inherit" },
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

  it("runs healthy ephemeral Postgres and Redis processes inside the single dev container", async () => {
    const dir = join("/tmp", "sandbox-integration-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "pg-fixture" } }),
      ".biodome/services.mjs": `
        export default function services(ctx) {
          ctx.addService("postgres", { port: 5432 });
          ctx.addService("redis", { port: 6379 });
        }
      `,
      ".biodome/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "20" });
        }
      `,
      "package.json": JSON.stringify({ name: "pg-fixture" }),
    });

    const project = `biodome-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      mkdirSync(join(dir, ".biodome-build", "healthchecks"), { recursive: true });
      mkdirSync(join(dir, ".biodome-build", "services"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      const supervisord = generateSupervisordConf(plan);
      if (supervisord) {
        writeFileSync(join(dir, ".biodome-build", "supervisord.conf"), supervisord);
      }
      const startup = generateStartupScript(plan);
      if (startup) writeFileSync(join(dir, ".biodome-build", "startup.sh"), startup);
      for (const [path, content] of Object.entries(generateHealthcheckScripts(plan))) {
        writeFileSync(join(dir, ".biodome-build", "healthchecks", path), content);
      }
      for (const [path, content] of Object.entries(generateInContainerServiceFiles(plan))) {
        writeFileSync(join(dir, ".biodome-build", "services", path), content);
      }
      writeFileSync(
        join(dir, ".sandbox", "docker-compose.yaml"),
        generateCompose(plan, {
          buildContext: "..",
          dockerfile: ".sandbox/Dockerfile",
          workspace: "..",
        }),
      );

      execFileSync(
        "docker",
        [
          "compose",
          "-f",
          ".sandbox/docker-compose.yaml",
          "-p",
          project,
          "up",
          "-d",
          "--build",
          "--wait",
        ],
        { cwd: dir, stdio: "inherit", env: hostIdentityEnv() },
      );

      // Postgres must become healthy and accept connections from inside dev.
      execFileSync(
        "docker",
        [
          "compose",
          "-f",
          ".sandbox/docker-compose.yaml",
          "-p",
          project,
          "exec",
          "-T",
          "dev",
          "pg_isready",
          "-U",
          "postgres",
          "-d",
          "postgres",
        ],
        { cwd: dir, stdio: "inherit" },
      );

      // The database server runs as its dedicated system user, never root.
      const postgresUid = supervisedProcessUid(
        dir,
        ".sandbox/docker-compose.yaml",
        project,
        "postgres-server",
      );
      expect(Number(postgresUid)).not.toBe(0);

      // Redis runs in-container too, under its own system user, and answers pings.
      execFileSync(
        "docker",
        [
          "compose",
          "-f",
          ".sandbox/docker-compose.yaml",
          "-p",
          project,
          "exec",
          "-T",
          "dev",
          "redis-cli",
          "ping",
        ],
        { cwd: dir, stdio: "inherit" },
      );
      const redisUid = supervisedProcessUid(
        dir,
        ".sandbox/docker-compose.yaml",
        project,
        "redis-server",
      );
      expect(Number(redisUid)).not.toBe(0);
      expect(redisUid).not.toBe(postgresUid);

      const ps = execFileSync(
        "docker",
        ["compose", "-f", ".sandbox/docker-compose.yaml", "-p", project, "ps", "--format", "json"],
        { cwd: dir, encoding: "utf-8" },
      );
      const services = ps
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { Service: string; Health?: string; State: string });
      expect(services).toHaveLength(1);
      expect(services[0]).toMatchObject({ Service: "dev", State: "running", Health: "healthy" });
    } finally {
      try {
        execFileSync(
          "docker",
          ["compose", "-f", ".sandbox/docker-compose.yaml", "-p", project, "down", "-v"],
          { cwd: dir, stdio: "ignore" },
        );
      } catch {
        // Ignore cleanup errors.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);

  it("builds a generated Dockerfile for a go project", async () => {
    const dir = join("/tmp", "sandbox-integration-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "go-fixture" } }),
      ".biodome/services.mjs": "export default function services() {}\n",
      ".biodome/features/go.mjs": `
        export default function go(ctx) {
          ctx.addLanguage("go", { version: "1.22" });
        }
      `,
      "go.mod": "module go-fixture\n\ngo 1.22\n",
      "go.sum": "",
    });

    const imageTag = `biodome-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      writeFileSync(join(dir, ".dockerignore"), "");

      execFileSync(
        "docker",
        ["buildx", "build", "-f", ".sandbox/Dockerfile", "-t", imageTag, "."],
        { cwd: dir, stdio: "inherit" },
      );

      // The Go module cache must have been populated.
      const output = execFileSync("docker", ["run", "--rm", imageTag, "go", "env", "GOMODCACHE"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(output.trim().length).toBeGreaterThan(0);
    } finally {
      try {
        execFileSync("docker", ["rmi", "-f", imageTag], { stdio: "ignore" });
      } catch {
        // Ignore cleanup errors.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);

  it("builds a generated Dockerfile with Python and Node runtimes", async () => {
    const dir = join("/tmp", "sandbox-integration-" + Date.now());
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: "py-node-fixture" } }),
      ".biodome/services.mjs": "export default function services() {}\n",
      ".biodome/features/python.mjs": `
        export default function python(ctx) {
          ctx.addLanguage("python", { version: "3.12" });
        }
      `,
      ".biodome/features/node.mjs": `
        export default function node(ctx) {
          ctx.addLanguage("node", { version: "20" });
        }
      `,
      "requirements.txt": "requests==2.32.3\n",
      "package.json": JSON.stringify({ name: "py-node-fixture" }),
    });

    const imageTag = `biodome-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      writeFileSync(join(dir, ".dockerignore"), "");

      execFileSync(
        "docker",
        ["buildx", "build", "-f", ".sandbox/Dockerfile", "-t", imageTag, "."],
        { cwd: dir, stdio: "inherit" },
      );

      const pythonOutput = execFileSync(
        "docker",
        ["run", "--rm", imageTag, "python", "--version"],
        { cwd: dir, encoding: "utf-8" },
      );
      expect(pythonOutput.trim()).toContain("Python 3.12");

      const nodeOutput = execFileSync("docker", ["run", "--rm", imageTag, "node", "--version"], {
        cwd: dir,
        encoding: "utf-8",
      });
      expect(nodeOutput.trim()).toContain("v20");
    } finally {
      try {
        execFileSync("docker", ["rmi", "-f", imageTag], { stdio: "ignore" });
      } catch {
        // Ignore cleanup errors.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600000);

  it("starts a daemon process and reports the dev service as healthy", async () => {
    const dir = join("/tmp", "sandbox-integration-" + Date.now());
    const projectName = `daemon-fixture-${Date.now()}`;
    const serverPy = `from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, format, *args):
        pass

HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
`;
    createProject(dir, {
      ".biodome/config.json": JSON.stringify({ project: { name: projectName } }),
      ".biodome/services.mjs": "export default function services() {}\n",
      ".biodome/features/python.mjs": `
        export default function python(ctx) {
          ctx.addLanguage("python", { version: "3.12" });
        }
      `,
      ".biodome/features/web.mjs": `
        export default function web(ctx) {
          ctx.addProcess({
            name: "web",
            command: ["python", "server.py"],
            port: 8000,
            healthCheck: { type: "http", url: "http://localhost:8000/" },
          });
        }
      `,
      "server.py": serverPy,
    });

    const project = `biodome-test-${Date.now()}`;
    try {
      mkdirSync(join(dir, ".sandbox"), { recursive: true });
      const plan = await buildPlan(dir);
      writeFileSync(join(dir, ".sandbox", "Dockerfile"), generateDockerfile(plan));
      const supervisord = generateSupervisordConf(plan);
      if (supervisord) {
        mkdirSync(join(dir, ".biodome-build"), { recursive: true });
        writeFileSync(join(dir, ".biodome-build", "supervisord.conf"), supervisord);
      }
      const startup = generateStartupScript(plan);
      if (startup) writeFileSync(join(dir, ".biodome-build", "startup.sh"), startup);
      writeFileSync(
        join(dir, ".sandbox", "docker-compose.yaml"),
        generateCompose(plan, {
          buildContext: "..",
          dockerfile: ".sandbox/Dockerfile",
          workspace: "..",
        }),
      );

      const healthchecks = generateHealthcheckScripts(plan);
      mkdirSync(join(dir, ".biodome-build", "healthchecks"), { recursive: true });
      for (const [name, content] of Object.entries(healthchecks)) {
        writeFileSync(join(dir, ".biodome-build", "healthchecks", name), content);
      }

      execFileSync(
        "docker",
        [
          "compose",
          "-f",
          ".sandbox/docker-compose.yaml",
          "-p",
          project,
          "up",
          "-d",
          "--build",
          "--wait",
        ],
        { cwd: dir, stdio: "inherit", env: hostIdentityEnv() },
      );

      // The dev service must be healthy, meaning the daemon passed its health check.
      const ps = execFileSync(
        "docker",
        ["compose", "-f", ".sandbox/docker-compose.yaml", "-p", project, "ps", "--format", "json"],
        { cwd: dir, encoding: "utf-8" },
      );
      const services = ps
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { Service: string; Health?: string; State: string });
      const dev = services.find((s) => s.Service === "dev");
      expect(dev).toBeDefined();
      expect(dev!.State).toBe("running");
      expect(dev!.Health).toBe("healthy");

      // User-declared workloads run as the non-root runtime identity mapped
      // onto the workspace owner.
      const webUid = supervisedProcessUid(dir, ".sandbox/docker-compose.yaml", project, "web");
      expect(Number(webUid)).not.toBe(0);
      expect(String(webUid)).toBe(hostIdentityEnv().BIODOME_RUNTIME_UID);

      // The workspace bind mount is writable by the runtime identity.
      execFileSync(
        "docker",
        [
          "compose",
          "-f",
          ".sandbox/docker-compose.yaml",
          "-p",
          project,
          "exec",
          "-T",
          "dev",
          "su",
          "biodome",
          "-s",
          "/bin/sh",
          "-c",
          "touch /workspace/.biodome-write-test && rm /workspace/.biodome-write-test",
        ],
        { cwd: dir, stdio: "inherit" },
      );

      // The healthcheck monitor program should also be running under supervisord.
      const status = execFileSync(
        "docker",
        [
          "compose",
          "-f",
          ".sandbox/docker-compose.yaml",
          "-p",
          project,
          "exec",
          "-T",
          "dev",
          "supervisorctl",
          "-c",
          "/workspace/.biodome-build/supervisord.conf",
          "status",
        ],
        { cwd: dir, encoding: "utf-8" },
      );
      expect(status).toContain("web");
      expect(status).toContain("web-healthcheck");
    } finally {
      try {
        execFileSync(
          "docker",
          ["compose", "-f", ".sandbox/docker-compose.yaml", "-p", project, "down", "-v"],
          { cwd: dir, stdio: "ignore" },
        );
      } catch {
        // Ignore cleanup errors.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);
});
