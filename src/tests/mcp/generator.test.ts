import { describe, it, expect } from "vitest";
import { createPlan } from "../../core/plan.js";
import { generatePlanJson } from "../../mcp/generator.js";

describe("generatePlanJson", () => {
  it("serializes an empty plan", () => {
    const plan = createPlan("test");
    const json = JSON.parse(generatePlanJson(plan));
    expect(json.project).toBe("test");
    expect(json.languages).toEqual([]);
    expect(json.services).toEqual([]);
    expect(json.processes).toEqual([]);
    expect(json.environment).toEqual({});
  });

  it("includes services with connection strings", () => {
    const plan = createPlan("app");
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      image: "postgres:16-alpine",
      containerName: "app-postgres",
      environment: {
        POSTGRES_USER: "myuser",
        POSTGRES_PASSWORD: "mypass",
        POSTGRES_DB: "mydb",
      },
      ports: [{ host: 5432, container: 5432 }],
      volumes: [],
      networks: ["biodome"],
    });

    const json = JSON.parse(generatePlanJson(plan));
    expect(json.services).toHaveLength(1);
    expect(json.services[0].name).toBe("postgres");
    expect(json.services[0].connection).not.toBeNull();
    expect(json.services[0].connection.internal).toContain("postgresql://");
    expect(json.services[0].connection.external).toContain("localhost:5432");
    expect(json.services[0].ports).toEqual([{ host: 5432, container: 5432 }]);
  });

  it("includes processes", () => {
    const plan = createPlan("app");
    plan.runtime.processes.push({
      name: "web",
      command: ["node", "server.js"],
      ports: [{ host: 3000, container: 3001 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const json = JSON.parse(generatePlanJson(plan));
    expect(json.processes).toHaveLength(1);
    expect(json.processes[0].name).toBe("web");
    expect(json.processes[0].mode).toBe("daemon");
    expect(json.processes[0].ports).toEqual([{ host: 3000, container: 3001 }]);
  });

  it("includes endpoints and preserves env references without resolving them", () => {
    const plan = createPlan("app");
    plan.runtime.endpoints.push({
      name: "django-api",
      description: "Django REST API",
      url: "http://localhost:8000",
      port: 8000,
      credentials: {
        username: "admin",
        password: { env: "DJANGO_ADMIN_PASSWORD" },
      },
      metadata: { framework: "django" },
    });

    const json = JSON.parse(generatePlanJson(plan));
    expect(json.endpoints).toHaveLength(1);
    expect(json.endpoints[0].name).toBe("django-api");
    expect(json.endpoints[0].url).toBe("http://localhost:8000");
    expect(json.endpoints[0].port).toBe(8000);
    // Env references stay as references — the secret is never written to disk.
    expect(json.endpoints[0].credentials.username).toBe("admin");
    expect(json.endpoints[0].credentials.password).toEqual({ env: "DJANGO_ADMIN_PASSWORD" });
    expect(json.endpoints[0].metadata).toEqual({ framework: "django" });
  });

  it("emits an empty endpoints array for a plan with none", () => {
    const plan = createPlan("app");
    const json = JSON.parse(generatePlanJson(plan));
    expect(json.endpoints).toEqual([]);
  });

  it("includes languages", () => {
    const plan = createPlan("app");
    plan.build.languageRequests.push({
      name: "node",
      options: { version: "20" },
    });

    const json = JSON.parse(generatePlanJson(plan));
    expect(json.languages).toHaveLength(1);
    expect(json.languages[0].name).toBe("node");
    expect(json.languages[0].version).toBe("20");
  });
});

describe("volume serialization", () => {
  it("includes proxy volumes with credential references", () => {
    const plan = createPlan("app");
    plan.runtime.volumes.push({
      name: "s3-data",
      type: "s3",
      target: "/workspace/s3-data",
      bucket: "my-bucket",
      prefix: "data/",
      proxy: true,
      readOnly: true,
      allowedPaths: ["**/*.pdf"],
      credentials: {
        accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
        secretAccessKey: "literal-secret",
      },
    });

    const json = JSON.parse(generatePlanJson(plan));
    expect(json.volumes).toHaveLength(1);
    const volume = json.volumes[0];
    expect(volume.name).toBe("s3-data");
    expect(volume.proxy).toBe(true);
    expect(volume.readOnly).toBe(true);
    expect(volume.allowedPaths).toEqual(["**/*.pdf"]);
    expect(volume.credentials.accessKeyId).toEqual({ env: "AWS_ACCESS_KEY_ID" });
    expect(volume.credentials.secretAccessKey).toBe("literal-secret");
  });

  it("includes non-proxy local volumes without credentials", () => {
    const plan = createPlan("app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      target: "/workspace/data",
      source: "./data",
    });

    const json = JSON.parse(generatePlanJson(plan));
    expect(json.volumes).toHaveLength(1);
    expect(json.volumes[0].proxy).toBe(false);
    expect(json.volumes[0].readOnly).toBe(false);
  });
});
