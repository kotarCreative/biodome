import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { ServiceBuilder } from "../../../core/plan-builder/services.js";

describe("ServiceBuilder", () => {
  it("applies a service configuration and records its named volumes", () => {
    const plan = createPlan("test");
    const builder = new ServiceBuilder(plan);

    builder.add("postgres", { databases: [{ name: "app" }] });

    expect(plan.runtime.services[0]).toMatchObject({
      name: "postgres",
      image: "postgres:16-alpine",
    });
    expect(plan.runtime.namedVolumes).toContainEqual({ name: "postgres_data" });
  });

  it("uses custom images for generic container services", () => {
    const plan = createPlan("test");
    const builder = new ServiceBuilder(plan);

    builder.add("proxy", { image: "nginx:latest", port: 8080 });

    expect(plan.runtime.services[0]).toMatchObject({
      type: "container",
      image: "nginx:latest",
      ports: [{ host: 8080, container: 8080 }],
    });
  });

  it("rejects duplicate service names and invalid ports", () => {
    const builder = new ServiceBuilder(createPlan("test"));
    builder.add("redis");

    expect(() => builder.add("redis")).toThrow(/Duplicate service name/);
    expect(() => builder.add("web", { port: 70000 })).toThrow(/integer between 1 and 65535/);
  });
});
