import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { generateStartupScript } from "../../../docker/generators/startup.js";

describe("generateStartupScript", () => {
  it("starts supervisord before pre-start hooks and post-start hooks after all daemons", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push(
      {
        name: "repo-sync-api",
        command: ["sh", "/workspace/.biodome-build/repos/api.sh"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.pre",
      },
      {
        name: "migrate",
        command: ["python", "manage.py", "migrate"],
        ports: [],
        environment: { DATABASE_URL: "postgres://db" },
        workingDir: "/workspace/apps/api",
        mode: "oneshot",
        startOn: "start.pre",
      },
      {
        name: "api",
        command: ["python", "manage.py", "runserver"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
      },
      {
        name: "announce",
        command: ["node", "ready.mjs"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.post",
      },
    );

    const script = generateStartupScript(plan)!;
    expect(script).toContain("cd /workspace/apps/api");
    expect(script).toContain("env DATABASE_URL='postgres://db' python manage.py migrate");
    expect(script).toContain(
      "chown --reference=/workspace/.biodome-build /workspace/.biodome-build/logs",
    );
    expect(script.indexOf("supervisord -c")).toBeLessThan(script.indexOf("repo-sync-api"));
    expect(script.indexOf("repo-sync-api")).toBeLessThan(script.indexOf("start all"));
    expect(script.indexOf("start all")).toBeLessThan(script.indexOf("announce"));
  });

  it("keeps a hook-only environment alive for subsequent task execution", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "setup",
      command: ["sh", "setup.sh"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.pre",
    });

    expect(generateStartupScript(plan)).toContain("exec sleep infinity");
  });

  it("starts and health-checks bootstrap processes before pre-start hooks", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push(
      {
        name: "postgres-server",
        command: ["sh", "postgres.sh"],
        ports: [],
        environment: {},
        healthCheck: { type: "tcp", port: 5432 },
        mode: "daemon",
        startOn: "start.post",
        bootstrap: true,
      },
      {
        name: "migrate",
        command: ["python", "manage.py", "migrate"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.pre",
      },
    );

    const script = generateStartupScript(plan)!;
    expect(script.indexOf("start postgres-server")).toBeLessThan(script.indexOf("migrate"));
    expect(script).toContain("healthchecks/postgres-server.sh");
  });

  it("rejects hook names that are not safe identifiers", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "hook-$(curl evil)",
      command: ["sh", "setup.sh"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.pre",
    });

    expect(() => generateStartupScript(plan)).toThrow(/Invalid hook name/);
  });

  it("rejects environment variable names that are not safe identifiers", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "setup",
      command: ["sh", "setup.sh"],
      ports: [],
      environment: { "A; curl evil": "x" },
      mode: "oneshot",
      startOn: "start.pre",
    });

    expect(() => generateStartupScript(plan)).toThrow(/Invalid environment variable name/);
  });
});
