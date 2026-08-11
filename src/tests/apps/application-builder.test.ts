import { describe, expect, it } from "vitest";
import { PlanBuilder } from "../../core/plan-builder/plan-builder.js";
import { ApplicationBuilderImpl } from "../../apps/application-builder.js";

function app(name = "backend") {
  const plan = new PlanBuilder("/tmp/app-builder", "test");
  const builder = new ApplicationBuilderImpl(plan.context, plan.applications, {
    name,
    declarationPath: `.biodome/apps/${name}.mjs`,
    knownApps: new Set([name]),
  });
  return { plan, builder };
}

function finalized(plan: PlanBuilder) {
  plan.finalize();
  return plan.getPlan();
}

describe("application builder", () => {
  it("scopes contributions and uses app-root defaults", () => {
    const { plan, builder } = app();
    builder.addRepository({ url: "git@example.test/backend.git" });
    builder.addHook("migrate", {
      command: ["python", "manage.py", "migrate"],
      startOn: "start.pre",
    });
    builder.addProcess("web", { command: ["python", "manage.py", "runserver"], port: 8000 });
    builder.exposeEndpoint("http", { process: "web" });
    const metadata = builder.finish();
    const result = finalized(plan);
    expect(result.runtime.repos[0]).toMatchObject({
      name: "backend",
      path: "/workspace/apps/backend",
    });
    expect(result.runtime.processes.map((item) => item.name)).toEqual(
      expect.arrayContaining(["backend:migrate", "backend:web"]),
    );
    expect(result.runtime.processes.find((item) => item.name === "backend:web")?.workingDir).toBe(
      "/workspace/apps/backend",
    );
    expect(result.runtime.endpoints[0]).toMatchObject({ name: "backend:http", port: 8000 });
    expect(metadata.processes).toEqual(["backend:web"]);
  });

  it("allows the same local process name in two apps and rejects local duplicates", () => {
    const first = app("api");
    const second = app("worker");
    first.builder.addProcess("web", { command: ["one"] });
    second.builder.addProcess("web", { command: ["two"] });
    expect(() => first.builder.addProcess("web", { command: ["again"] })).toThrow(
      "Duplicate process",
    );
    expect(finalized(first.plan).runtime.processes[0].name).toBe("api:web");
    expect(finalized(second.plan).runtime.processes[0].name).toBe("worker:web");
  });

  it("binds application environment variables to declared service environment keys", () => {
    const { plan, builder } = app();
    plan.context.addService("postgres", {
      environment: { POSTGRES_CONNECTION: "postgresql://postgres:postgres@postgres:5432/app" },
    });

    builder.requireService("postgres", {
      environment: { DATABASE_URL: "POSTGRES_CONNECTION" },
    });

    const result = finalized(plan);
    expect(result.runtime.environment.DATABASE_URL).toBe(
      "postgresql://postgres:postgres@postgres:5432/app",
    );
    expect(result.runtime.envVars).toContainEqual({
      key: "DATABASE_URL",
      scope: "runtime",
      value: "postgresql://postgres:postgres@postgres:5432/app",
    });
    expect(builder.finish().requiredServices).toEqual(["postgres"]);
  });

  it("rejects bindings to unknown service environment keys", () => {
    const { plan, builder } = app();
    plan.context.addService("postgres");

    expect(() =>
      builder.requireService("postgres", { environment: { DATABASE_URL: "DATABASE_URL" } }),
    ).toThrow(
      'Application "backend" service "postgres" references invalid environment key "DATABASE_URL"',
    );
  });

  it("rejects namespace escape attempts for local declarations", () => {
    const { builder } = app();

    expect(() => builder.addHook("other:migrate", { command: ["echo", "migrate"] })).toThrow(
      'Application "backend" local declaration name must not contain ":"',
    );
    expect(() => builder.addProcess("other:web", { command: ["node"] })).toThrow(
      'Application "backend" local declaration name must not contain ":"',
    );
    expect(() => builder.exposeEndpoint("other:http", {})).toThrow(
      'Application "backend" local declaration name must not contain ":"',
    );
  });

  it("allows qualified process names only when an endpoint references a process", () => {
    const { plan, builder } = app();
    plan.context.addProcess({ name: "other:web", command: ["node"], port: 4300 });

    builder.exposeEndpoint("other-web", { process: "other:web" });

    expect(finalized(plan).runtime.endpoints[0]).toMatchObject({
      name: "backend:other-web",
      port: 4300,
    });
  });
});
