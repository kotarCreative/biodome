import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { ServiceBuilder } from "../../../core/plan-builder/services.js";

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
    );

    builder.add("postgres", { databases: [{ name: "app" }] });

    expect(plan.runtime.services[0]).toMatchObject({
      name: "postgres",
      image: "postgresql (in-container)",
      runtime: "process",
    });
    expect(plan.runtime.namedVolumes).not.toContainEqual({ name: "postgres_data" });
    expect(packages).toEqual(expect.arrayContaining(["postgresql"]));
    expect(processes).toContainEqual(
      expect.objectContaining({ name: "postgres-server", bootstrap: true }),
    );
    expect(hooks).toContainEqual(expect.objectContaining({ name: "postgres-init" }));
  });

  it("uses custom images for generic container services", () => {
    const plan = createPlan("test");
    const builder = new ServiceBuilder(
      plan,
      () => {},
      () => {},
      () => {},
      "/services",
    );

    builder.add("proxy", { image: "nginx:latest", port: 8080 });

    expect(plan.runtime.services[0]).toMatchObject({
      type: "container",
      image: "nginx:latest",
      ports: [{ host: 8080, container: 8080 }],
    });
  });

  it("rejects duplicate service names and invalid ports", () => {
    const builder = new ServiceBuilder(
      createPlan("test"),
      () => {},
      () => {},
      () => {},
      "/services",
    );
    builder.add("redis");

    expect(() => builder.add("redis")).toThrow(/Duplicate service name/);
    expect(() => builder.add("web", { port: 70000 })).toThrow(/integer between 1 and 65535/);
  });
});
