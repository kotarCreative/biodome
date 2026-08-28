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
      expect.arrayContaining(["app-7-backend-migrate", "app-7-backend-web"]),
    );
    expect(
      result.runtime.processes.find((item) => item.name === "app-7-backend-web")?.workingDir,
    ).toBe("/workspace/apps/backend");
    expect(result.runtime.endpoints[0]).toMatchObject({
      name: "app-7-backend-http",
      port: 8000,
    });
    expect(metadata.processes).toEqual(["app-7-backend-web"]);
  });

  it("allows the same local process name in two apps and rejects local duplicates", () => {
    const first = app("api");
    const second = app("worker");
    first.builder.addProcess("web", { command: ["one"] });
    second.builder.addProcess("web", { command: ["two"] });
    expect(() => first.builder.addProcess("web", { command: ["again"] })).toThrow(
      "Duplicate process",
    );
    expect(finalized(first.plan).runtime.processes[0].name).toBe("app-3-api-web");
    expect(finalized(second.plan).runtime.processes[0].name).toBe("app-6-worker-web");
  });

  it("qualifies adversarial hyphenated app and local names injectively", () => {
    const plan = new PlanBuilder("/tmp/app-builder", "test");
    const knownApps = new Set(["foo", "foo-bar"]);
    const foo = new ApplicationBuilderImpl(plan.context, plan.applications, {
      name: "foo",
      declarationPath: ".biodome/apps/foo.mjs",
      knownApps,
    });
    const fooBar = new ApplicationBuilderImpl(plan.context, plan.applications, {
      name: "foo-bar",
      declarationPath: ".biodome/apps/foo-bar.mjs",
      knownApps,
    });

    foo.addProcess("bar-baz", { command: ["foo"], port: 3000 });
    foo.exposeEndpoint("bar-baz", { process: "bar-baz" });
    fooBar.addProcess("baz", { command: ["foo-bar"], port: 4000 });
    fooBar.exposeEndpoint("baz", { process: "baz" });

    const result = finalized(plan);
    const processNames = result.runtime.processes.map((process) => process.name);
    const endpointNames = result.runtime.endpoints.map((endpoint) => endpoint.name);
    expect(processNames).toEqual(
      expect.arrayContaining(["app-3-foo-bar-baz", "app-7-foo-bar-baz"]),
    );
    expect(endpointNames).toEqual(
      expect.arrayContaining(["app-3-foo-bar-baz", "app-7-foo-bar-baz"]),
    );
    expect(new Set(processNames)).toHaveProperty("size", processNames.length);
    expect(processNames.every((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))).toBe(true);
  });

  it("does not resolve an endpoint reference to a colliding declaration from another app", () => {
    const plan = new PlanBuilder("/tmp/app-builder", "test");
    const knownApps = new Set(["consumer", "foo", "foo-bar"]);
    const fooBar = new ApplicationBuilderImpl(plan.context, plan.applications, {
      name: "foo-bar",
      declarationPath: ".biodome/apps/foo-bar.mjs",
      knownApps,
    });
    const consumer = new ApplicationBuilderImpl(plan.context, plan.applications, {
      name: "consumer",
      declarationPath: ".biodome/apps/consumer.mjs",
      knownApps,
    });
    fooBar.exposeEndpoint("baz", { port: 4000 });

    expect(() =>
      consumer.requireAppEndpoint({
        _tag: "AppEndpointReference",
        app: "foo",
        endpoint: "bar-baz",
      }),
    ).toThrow('references endpoint "foo.bar-baz", which is not declared');
  });

  it("does not resolve an app reference to an unrelated global endpoint", () => {
    const plan = new PlanBuilder("/tmp/app-builder", "test");
    plan.context.addEndpoint({ name: "app-3-foo-bar", port: 4000 });
    const consumer = new ApplicationBuilderImpl(plan.context, plan.applications, {
      name: "consumer",
      declarationPath: ".biodome/apps/consumer.mjs",
      knownApps: new Set(["consumer", "foo"]),
    });

    expect(() =>
      consumer.requireAppEndpoint({
        _tag: "AppEndpointReference",
        app: "foo",
        endpoint: "bar",
      }),
    ).toThrow('references endpoint "foo.bar", which is not declared');
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
      'Invalid local declaration for application "backend" name',
    );
    expect(() => builder.addProcess("other:web", { command: ["node"] })).toThrow(
      'Invalid local declaration for application "backend" name',
    );
    expect(() => builder.exposeEndpoint("other:http", {})).toThrow(
      'Invalid local declaration for application "backend" name',
    );
  });

  it(`rejects ":" references in endpoint process options`, () => {
    const { builder } = app();

    expect(() => builder.exposeEndpoint("http", { process: "other:web" })).toThrow(
      'Invalid local declaration for application "backend" name',
    );
  });
});
