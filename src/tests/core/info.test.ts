import { describe, it, expect } from "vitest";
import { formatInfo, formatAgentsMd } from "../../core/info.js";
import { createPlan } from "../../core/plan.js";

describe("formatInfo", () => {
  it("includes project and base image", () => {
    const plan = createPlan("my-app");
    plan.build.baseImage = "node:20-slim";

    const info = formatInfo(plan);
    expect(info).toContain("Project: my-app");
    expect(info).toContain("Base image: node:20-slim");
  });

  it("lists services with connection strings", () => {
    const plan = createPlan("my-app");
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      image: "postgres:16-alpine",
      containerName: "my-app-postgres",
      environment: {
        POSTGRES_USER: "app",
        POSTGRES_PASSWORD: "dev",
        POSTGRES_DB: "myapp",
      },
      ports: [{ host: 5432, container: 5432 }],
      volumes: [],
      networks: ["sandbox"],
    });

    const info = formatInfo(plan);
    expect(info).toContain("Services:");
    expect(info).toContain("postgresql://app:dev@postgres:5432/myapp");
    expect(info).toContain("postgresql://app:dev@localhost:5432/myapp");
  });

  it("lists hooks", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "migrate",
      command: ["python", "manage.py", "migrate"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.post",
    });

    const info = formatInfo(plan);
    expect(info).toContain("Hooks:");
    expect(info).toContain("migrate: python manage.py migrate @ start.post");
  });
});

describe("formatAgentsMd", () => {
  it("generates markdown with service details", () => {
    const plan = createPlan("my-app");
    plan.build.baseImage = "node:20-slim";
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      image: "postgres:16-alpine",
      containerName: "my-app-postgres",
      environment: {
        POSTGRES_USER: "app",
        POSTGRES_PASSWORD: "dev",
        POSTGRES_DB: "myapp",
      },
      ports: [{ host: 5432, container: 5432 }],
      volumes: [],
      networks: ["sandbox"],
    });

    const md = formatAgentsMd(plan);
    expect(md).toContain("# Development Environment");
    expect(md).toContain("node:20-slim");
    expect(md).toContain("### postgres");
    expect(md).toContain("postgresql://app:dev@postgres:5432/myapp");
    expect(md).toContain("sandbox up");
  });
});
