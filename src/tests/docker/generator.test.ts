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
    expect(dockerfile).toContain('CMD ["supervisord", "-c", "/workspace/.biodome/supervisord.conf"]');
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
    expect(conf).toContain("sh /workspace/.biodome/healthchecks/django-monitor.sh");
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
    expect(compose).toContain("sh /workspace/.biodome/healthchecks/all.sh");
    expect(compose).not.toContain("sleep infinity");
    expect(compose).toContain("..:/workspace");

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["django.sh"]).toContain("curl -fsS");
    expect(healthchecks["django.sh"]).toContain("http://localhost:8000/admin/login/");
    expect(healthchecks["django-monitor.sh"]).toContain("supervisorctl");
    expect(healthchecks["all.sh"]).toContain("sh /workspace/.biodome/healthchecks/django.sh");
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
    expect(dockerignore).toContain(".biodome/*");
    expect(dockerignore).toContain("!.biodome/supervisord.conf");
    expect(dockerignore).not.toContain(".biodome\n");
  });
});
