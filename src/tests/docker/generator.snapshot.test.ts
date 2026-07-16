import { describe, it, expect } from "vitest";
import { generateDockerfile, generateCompose, generateSupervisordConf } from "../../docker/generator.js";
import { createPlan } from "../../core/plan.js";

describe("Docker generator snapshots", () => {
  it("matches for node + postgres + daemon", () => {
    const plan = createPlan("my-app");
    plan.build.baseImage = "node:20-slim";
    plan.build.aptPackages = ["curl"];
    plan.build.nodeModulesVolume = true;
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      image: "postgres:16-alpine",
      containerName: "my-app-postgres",
      environment: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "dev", POSTGRES_DB: "myapp" },
      ports: [{ host: 5432, container: 5432 }],
      volumes: [{ host: "postgres_data", container: "/var/lib/postgresql/data" }],
      networks: ["biodome"],
      healthCheck: {
        test: ["CMD-SHELL", "pg_isready -U app -d myapp"],
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });
    plan.runtime.processes.push({
      name: "web",
      command: ["node", "server.js"],
      ports: [{ host: 3000, container: 3000 }],
      environment: { DEBUG: "1" },
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:3000/health",
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    expect(generateDockerfile(plan)).toMatchSnapshot();
    expect(generateSupervisordConf(plan)).toMatchSnapshot();
    expect(generateCompose(plan)).toMatchSnapshot();
  });

  it("matches for python + venv + redis", () => {
    const plan = createPlan("py-app");
    plan.build.baseImage = "python:3.12-slim";
    plan.build.aptPackages = ["supervisor"];
    plan.build.venvVolume = true;
    plan.build.dependencyFiles = ["requirements.txt"];
    plan.build.dependencyInstalls.push({
      files: ["requirements.txt"],
      command: "RUN python -m venv /workspace/.venv && /workspace/.venv/bin/pip install -r requirements.txt",
    });
    plan.build.copyArtifacts.push({
      files: ["requirements.txt"],
      lines: ["COPY --from=deps /workspace/.venv /workspace/.venv", "ENV PATH=/workspace/.venv/bin:$PATH"],
    });
    plan.runtime.services.push({
      name: "redis",
      type: "redis",
      image: "redis:7-alpine",
      containerName: "py-app-redis",
      environment: {},
      ports: [{ host: 6379, container: 6379 }],
      volumes: [{ host: "redis_data", container: "/data" }],
      networks: ["biodome"],
      healthCheck: {
        test: ["CMD-SHELL", "redis-cli ping | grep -q PONG"],
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    expect(generateDockerfile(plan)).toMatchSnapshot();
    expect(generateSupervisordConf(plan)).toMatchSnapshot();
    expect(generateCompose(plan)).toMatchSnapshot();
  });

  it("matches for multi-daemon with workingDir + tcp healthcheck", () => {
    const plan = createPlan("multi-app");
    plan.build.baseImage = "node:20-slim";
    plan.build.aptPackages = ["supervisor", "netcat-openbsd"];
    plan.runtime.processes.push({
      name: "backend",
      command: ["node", "api.js"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: { type: "tcp", port: 8000 },
    });
    plan.runtime.processes.push({
      name: "frontend",
      command: ["npm", "run", "dev"],
      ports: [{ host: 3000, container: 3000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      workingDir: "/workspace/frontend",
    });

    expect(generateDockerfile(plan)).toMatchSnapshot();
    expect(generateSupervisordConf(plan)).toMatchSnapshot();
    expect(generateCompose(plan)).toMatchSnapshot();
  });

  it("matches for no-language bash fallback", () => {
    const plan = createPlan("bash-app");
    expect(generateDockerfile(plan)).toMatchSnapshot();
    expect(generateSupervisordConf(plan)).toMatchSnapshot();
    expect(generateCompose(plan)).toMatchSnapshot();
  });

  it("matches for multi-language runtime installs", () => {
    const plan = createPlan("multi-lang");
    plan.build.baseImage = "debian:12-slim";
    plan.build.runtimeInstalls = [
      'RUN apt-get update && curl -fsSL https://pyenv.run | bash',
      'RUN apt-get update && curl -fsSL https://deb.nodesource.com/setup_20.x | bash',
    ];
    plan.build.languageSnippets = ['RUN corepack enable'];
    plan.build.dependencyFiles = ["requirements.txt", "package.json", "package-lock.json"];
    plan.build.dependencyInstalls.push(
      {
        files: ["requirements.txt"],
        command: "RUN python -m venv /workspace/.venv && /workspace/.venv/bin/pip install -r requirements.txt",
      },
      {
        files: ["package.json", "package-lock.json"],
        command: "RUN npm ci",
      }
    );
    plan.build.copyArtifacts.push(
      {
        files: ["requirements.txt"],
        lines: ["COPY --from=deps /workspace/.venv /workspace/.venv", "ENV PATH=/workspace/.venv/bin:$PATH"],
      },
      {
        files: ["package.json"],
        lines: ["COPY --from=deps /workspace/node_modules /workspace/node_modules"],
      }
    );
    plan.build.venvVolume = true;
    plan.build.nodeModulesVolume = true;

    expect(generateDockerfile(plan)).toMatchSnapshot();
    expect(generateSupervisordConf(plan)).toMatchSnapshot();
    expect(generateCompose(plan)).toMatchSnapshot();
  });
});
