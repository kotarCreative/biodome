import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import type { EnvSpec } from "../../../core/feature.js";
import { ServiceBuilder } from "../../../core/plan-builder/services.js";

interface EnvDeclaration {
  key: string;
  spec: EnvSpec;
}

function makeBuilder(plan: ReturnType<typeof createPlan>, env: EnvDeclaration[]): ServiceBuilder {
  return new ServiceBuilder(
    plan,
    () => {},
    () => {},
    () => {},
    "/services",
    (key, spec) => env.push({ key, spec }),
  );
}

describe("ServiceBuilder", () => {
  it("applies a service configuration and records its named volumes", () => {
    const plan = createPlan("test");
    const packages: string[] = [];
    const processes: unknown[] = [];
    const hooks: unknown[] = [];
    const builder = new ServiceBuilder(
      plan,
      (name) => packages.push(name),
      (spec) => processes.push(spec),
      (spec) => hooks.push(spec),
      "/workspace/.biodome-build/services",
      () => {},
    );

    builder.add("postgres", { databases: [{ name: "app" }] });

    expect(plan.runtime.services[0]).toMatchObject({
      name: "postgres",
      type: "postgres",
    });
    expect(packages).toEqual(expect.arrayContaining(["postgresql"]));
    expect(processes).toContainEqual(
      expect.objectContaining({ name: "postgres-server", bootstrap: true }),
    );
    expect(hooks).toContainEqual(expect.objectContaining({ name: "postgres-init" }));
  });

  it("runs redis in-container with a supervised server process and no named volume", () => {
    const plan = createPlan("test");
    const packages: string[] = [];
    const processes: unknown[] = [];
    const builder = new ServiceBuilder(
      plan,
      (name) => packages.push(name),
      (spec) => processes.push(spec),
      () => {},
      "/workspace/.biodome-build/services",
      () => {},
    );

    builder.add("redis", { port: 6380 });

    expect(plan.runtime.services[0]).toMatchObject({
      name: "redis",
      type: "redis",
      ports: [{ host: 6380, container: 6380 }],
    });
    expect(plan.runtime.namedVolumes).toEqual([]);
    expect(packages).toEqual(expect.arrayContaining(["redis-server"]));
    expect(processes).toContainEqual(
      expect.objectContaining({
        name: "redis-server",
        bootstrap: true,
        healthCheck: { type: "tcp", port: 6380, interval: "1s", retries: 30, startPeriod: "1s" },
      }),
    );
  });

  it("defaults the service port to the type's well-known port", () => {
    const plan = createPlan("test");
    const processes: unknown[] = [];
    const builder = new ServiceBuilder(
      plan,
      () => {},
      (spec) => processes.push(spec),
      () => {},
      "/services",
      () => {},
    );

    builder.add("redis");

    expect(processes).toContainEqual(
      expect.objectContaining({
        name: "redis-server",
        healthCheck: expect.objectContaining({ port: 6379 }),
      }),
    );
    expect(plan.runtime.services[0].ports).toEqual([]);
  });

  it("rejects service types that cannot run inside the single dev image", () => {
    const plan = createPlan("test");
    const builder = makeBuilder(plan, []);

    expect(() => builder.add("proxy", { port: 8080 })).toThrow(
      /Unsupported service "proxy".*postgres, redis/,
    );
    expect(plan.runtime.services).toHaveLength(0);
  });

  it("rejects duplicate service names and invalid ports", () => {
    const builder = makeBuilder(createPlan("test"), []);
    builder.add("redis");

    expect(() => builder.add("redis")).toThrow(/Duplicate service name/);
    expect(() => builder.add("redis", { port: 70000 })).toThrow(/integer between 1 and 65535/);
  });

  it("injects a literal user password as a runtime env var and on the service", () => {
    const plan = createPlan("test");
    const env: EnvDeclaration[] = [];
    const builder = makeBuilder(plan, env);

    builder.add("postgres", { users: [{ name: "myapp", password: "devpassword" }] });

    expect(env).toEqual([{ key: "POSTGRES_PASSWORD", spec: { value: "devpassword" } }]);
    expect(plan.runtime.services[0].environment.POSTGRES_PASSWORD).toBe("devpassword");
  });

  it("registers an env-referenced password as a required host passthrough without baking the value", () => {
    const plan = createPlan("test");
    const env: EnvDeclaration[] = [];
    const builder = makeBuilder(plan, env);

    builder.add("postgres", {
      users: [{ name: "myapp", password: { env: "MY_PG_PASSWORD" } }],
    });

    expect(env).toEqual([
      {
        key: "POSTGRES_PASSWORD",
        spec: { from: { env: "MY_PG_PASSWORD" }, required: true },
      },
    ]);
    expect(plan.runtime.services[0].environment).not.toHaveProperty("POSTGRES_PASSWORD");
  });

  it("falls back to the top-level password option when registering credentials", () => {
    const plan = createPlan("test");
    const env: EnvDeclaration[] = [];
    const builder = makeBuilder(plan, env);

    builder.add("postgres", { password: { env: "FALLBACK_PG_PASSWORD" } });

    expect(env).toEqual([
      {
        key: "POSTGRES_PASSWORD",
        spec: { from: { env: "FALLBACK_PG_PASSWORD" }, required: true },
      },
    ]);
  });

  it("declares no credential env var when no password is configured", () => {
    const plan = createPlan("test");
    const env: EnvDeclaration[] = [];
    const builder = makeBuilder(plan, env);

    builder.add("postgres", { databases: [{ name: "app" }] });

    expect(env).toEqual([]);
    // The default literal remains recorded for info surfaces and app bindings.
    expect(plan.runtime.services[0].environment.POSTGRES_PASSWORD).toBe("postgres");
  });

  it("rejects invalid environment references in service passwords", () => {
    const builder = makeBuilder(createPlan("test"), []);

    expect(() =>
      builder.add("postgres", { users: [{ name: "app", password: { env: "123_BAD" } }] }),
    ).toThrow(/valid environment variable name/);
  });
});
