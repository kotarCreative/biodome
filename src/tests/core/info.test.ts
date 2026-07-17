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
      networks: ["biodome"],
    });

    const info = formatInfo(plan);
    expect(info).toContain("Services:");
    expect(info).toContain("postgresql://app:dev@postgres:5432/myapp");
    expect(info).toContain("postgresql://app:dev@localhost:5432/myapp");
  });

  it("lists endpoints with credentials, showing env refs symbolically", () => {
    const plan = createPlan("my-app");
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

    const info = formatInfo(plan);
    expect(info).toContain("Endpoints:");
    expect(info).toContain("django-api");
    expect(info).toContain("http://localhost:8000");
    expect(info).toContain("username: admin");
    // Env-referenced secrets are shown as a reference, never resolved on the host.
    expect(info).toContain("$DJANGO_ADMIN_PASSWORD");
    expect(info).not.toContain("password: DJANGO_ADMIN_PASSWORD ");
    expect(info).toContain("framework: django");
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
      networks: ["biodome"],
    });

    const md = formatAgentsMd(plan);
    expect(md).toContain("# Development Environment");
    expect(md).toContain("node:20-slim");
    expect(md).toContain("### postgres");
    expect(md).toContain("postgresql://app:dev@postgres:5432/myapp");
    expect(md).toContain("biodome up");
  });

  it("documents endpoints with URLs, ports, and credentials", () => {
    const plan = createPlan("my-app");
    plan.runtime.endpoints.push({
      name: "django-api",
      description: "Django REST API",
      url: "http://localhost:8000",
      port: 8000,
      credentials: {
        username: "admin",
        token: { env: "DJANGO_API_TOKEN" },
      },
    });

    const md = formatAgentsMd(plan);
    expect(md).toContain("## Endpoints");
    expect(md).toContain("### django-api");
    expect(md).toContain("Django REST API");
    expect(md).toContain("- URL: `http://localhost:8000`");
    expect(md).toContain("- Port: `8000`");
    expect(md).toContain("username: `admin`");
    expect(md).toContain("$DJANGO_API_TOKEN");
  });
});
