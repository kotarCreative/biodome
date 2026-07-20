import { describe, it, expect } from "vitest";
import {
  generateDockerfile,
  generateSupervisordConf,
  generateCompose,
  generateDockerignore,
  generateHealthcheckScripts,
} from "../../docker/generator.js";
import { createPlan } from "../../core/plan.js";

describe("Docker generators", () => {
  it("generates a Dockerfile with supervisord for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.build.baseImage = "python:3.12-slim";
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("FROM python:3.12-slim AS base");
    expect(dockerfile).toContain("supervisor");
    expect(dockerfile).toContain("supervisord.conf");
    expect(dockerfile).toContain('CMD ["supervisord", "-c", "/workspace/.biodome-build/supervisord.conf"]');
    expect(dockerfile).not.toContain('CMD ["bash"]');
  });

  it("generates supervisord.conf for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("[program:django]");
    expect(conf).toContain("command=python manage.py runserver 0.0.0.0:8000");
    expect(conf).toContain("[supervisord]");
  });

  it("generates supervisord healthcheck programs and RPC config", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:8000/admin/login/",
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("[unix_http_server]");
    expect(conf).toContain("[supervisorctl]");
    expect(conf).toContain("[rpcinterface:supervisor]");
    expect(conf).toContain("[program:django-healthcheck]");
    expect(conf).toContain("sh /workspace/.biodome-build/healthchecks/django-monitor.sh");
  });

  it("does not include bash CMD when no daemon processes exist", () => {
    const plan = createPlan("my-app");
    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain('CMD ["bash"]');
  });

  it("generates compose with ports and no sleep infinity for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:8000/admin/login/",
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("8000:8000");
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("sh /workspace/.biodome-build/healthchecks/all.sh");
    expect(compose).not.toContain("sleep infinity");
    expect(compose).toContain("..:/workspace");

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["django.sh"]).toContain("curl -fsS");
    expect(healthchecks["django.sh"]).toContain("http://localhost:8000/admin/login/");
    expect(healthchecks["django-monitor.sh"]).toContain("supervisorctl");
    expect(healthchecks["all.sh"]).toContain("sh /workspace/.biodome-build/healthchecks/django.sh");
  });

  it("bakes literal env vars into the Dockerfile and compose", () => {
    const plan = createPlan("my-app");
    plan.build.environment.DEBUG = "1";
    plan.runtime.environment.DEBUG = "1";
    plan.runtime.envVars.push({ key: "DEBUG", scope: "both", value: "1" });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("DEBUG=1");

    const compose = generateCompose(plan);
    expect(compose).toContain("DEBUG: \"1\"");
  });

  it("emits passthrough env vars as compose interpolations, not literals", () => {
    const plan = createPlan("my-app");
    plan.runtime.envVars.push(
      { key: "DATABASE_URL", scope: "runtime", from: { env: "DATABASE_URL" }, required: true },
      { key: "PORT", scope: "runtime", from: { env: "PORT" }, default: "8000" },
      { key: "API_KEY", scope: "runtime", from: { env: "API_KEY" } }
    );

    const compose = generateCompose(plan);
    // Required -> fails compose if unset.
    expect(compose).toContain("${DATABASE_URL:?DATABASE_URL is required by DATABASE_URL}");
    // Default -> falls back.
    expect(compose).toContain("${PORT:-8000}");
    // Plain passthrough.
    expect(compose).toContain("${API_KEY}");

    // Secrets are never baked into the image.
    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).not.toContain("DATABASE_URL");
    expect(dockerfile).not.toContain("API_KEY");
  });

  it("keeps build-scoped passthrough vars out of the runtime compose env", () => {
    const plan = createPlan("my-app");
    plan.runtime.envVars.push({
      key: "BUILD_TOKEN",
      scope: "build",
      from: { env: "BUILD_TOKEN" },
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("BUILD_TOKEN");
  });

  it("generates health check scripts with timeout in seconds", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "web",
      command: ["node", "server.js"],
      ports: [{ host: 3000, container: 3000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:3000/health",
        timeout: "2s",
      },
    });

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["web.sh"]).toContain("curl -fsS --max-time 2");
  });

  it("quotes exec health check commands for the shell", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "custom",
      command: ["node", "server.js"],
      ports: [{ host: 3000, container: 3000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "exec",
        command: ["sh", "-c", "curl -f http://localhost/"],
      },
    });

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["custom.sh"]).toContain("sh -c 'curl -f http://localhost/'");
  });

  it("generates a .dockerignore that excludes .biodome but keeps supervisord.conf", () => {
    const dockerignore = generateDockerignore();
    expect(dockerignore).toContain(".biodome-build/*");
    expect(dockerignore).toContain("!.biodome-build/supervisord.conf");
    expect(dockerignore).not.toContain(".biodome-build\n");
  });

  it("adds local bind mounts to the dev service", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("./data:/workspace/data");
  });

  it("adds read-only local bind mounts", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
      readOnly: true,
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("./data:/workspace/data:ro");
  });

  it("declares named local volumes in the compose volumes section", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "shared",
      type: "local",
      source: "shared-data",
      target: "/workspace/shared",
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("shared-data:/workspace/shared");
    expect(compose).toContain("volumes:\n  shared-data:");
  });

  it("enables privileged mode for cloud-backed volumes", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "s3-data",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-data",
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("privileged: true");
  });

  it("does not enable privileged mode for local volumes only", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("privileged");
  });

  it("does not enable privileged mode when all cloud volumes are proxy volumes", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "s3-proxy",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-proxy",
      proxy: true,
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("privileged");
    expect(compose).not.toContain("/workspace/s3-proxy");
  });

  it("installs only the provider SDKs needed by proxy volumes in the Dockerfile", () => {
    const plan = createPlan("my-app");
    plan.build.mcpEnabled = true;
    plan.runtime.volumes.push({
      name: "s3-proxy",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-proxy",
      proxy: true,
    });
    plan.runtime.volumes.push({
      name: "azure-proxy",
      type: "azure",
      account: "myaccount",
      container: "mycontainer",
      target: "/workspace/azure-proxy",
      proxy: true,
    });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("@aws-sdk/client-s3");
    expect(dockerfile).toContain("@azure/storage-blob");
    expect(dockerfile).not.toContain("@google-cloud/storage");
  });

  it("does not install provider SDKs when no proxy volumes exist", () => {
    const plan = createPlan("my-app");
    plan.build.mcpEnabled = true;

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("@modelcontextprotocol/sdk");
    expect(dockerfile).not.toContain("@aws-sdk/client-s3");
    expect(dockerfile).not.toContain("@google-cloud/storage");
    expect(dockerfile).not.toContain("@azure/storage-blob");
  });

  it("does not mount local proxy volumes in the dev service", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "local-proxy",
      type: "local",
      source: "./data",
      target: "/workspace/data",
      proxy: true,
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("./data:/workspace/data");
  });
});
