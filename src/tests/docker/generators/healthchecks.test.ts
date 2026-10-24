import { describe, expect, it } from "vitest";
import { generateHealthcheckScripts } from "../../../docker/generators/healthchecks.js";
import { createPlan } from "../../../core/plan.js";

describe("generateHealthcheckScripts", () => {
  it("requires completed startup even when there are no daemons", () => {
    const script = generateHealthcheckScripts(createPlan("command-only"))["all.sh"];
    expect(script).toContain("set -e\ntest -f /workspace/.biodome-build/ready");
    expect(script).not.toContain("exit 0");
  });
  it("generates per-process checks, monitors, and an aggregate check", () => {
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

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["django.sh"]).toContain("curl -fsS");
    expect(healthchecks["django.sh"]).toContain("http://localhost:8000/admin/login/");
    expect(healthchecks["django-monitor.sh"]).toContain("supervisorctl");
    expect(healthchecks["all.sh"]).toContain("sh /workspace/.biodome-build/healthchecks/django.sh");
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

  it("quotes health check URLs so shell metacharacters stay inert", () => {
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
        url: "http://localhost:3000/health; curl evil",
      },
    });

    const healthchecks = generateHealthcheckScripts(plan);
    expect(healthchecks["web.sh"]).toContain("'http://localhost:3000/health; curl evil'");
  });

  it("rejects process names that are not safe identifiers", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "web-$(id)",
      command: ["node", "server.js"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: { type: "http", url: "http://localhost:3000" },
    });

    expect(() => generateHealthcheckScripts(plan)).toThrow(/Invalid process name/);
  });
});
