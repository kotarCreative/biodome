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
    expect(info).toContain("postgresql://app@postgres:5432/myapp");
    expect(info).toContain("postgresql://app@localhost:5432/myapp");
  });

  it("lists endpoints with credentials, showing env refs symbolically", () => {
    const plan = createPlan("my-app");
    plan.runtime.endpoints.push({
      name: "django-api",
      description: "Django REST API",
      url: "http://localhost:8000",
      port: 8000,
      credentials: {
        username: { env: "DJANGO_ADMIN_USERNAME" },
        password: { env: "DJANGO_ADMIN_PASSWORD" },
      },
      metadata: { framework: "django" },
    });

    const info = formatInfo(plan);
    expect(info).toContain("Endpoints:");
    expect(info).toContain("django-api");
    expect(info).toContain("http://localhost:8000");
    expect(info).toContain("username: $DJANGO_ADMIN_USERNAME");
    // Env-referenced secrets are shown as a reference, never resolved on the host.
    expect(info).toContain("$DJANGO_ADMIN_PASSWORD");
    expect(info).toContain("framework: django");
  });

  it("renders service credential passthrough vars without exposing values", () => {
    const plan = createPlan("my-app");
    plan.runtime.envVars.push({
      key: "POSTGRES_PASSWORD",
      scope: "runtime",
      from: { env: "MY_PG_PASSWORD" },
      required: true,
    });

    const info = formatInfo(plan);
    expect(info).toContain("POSTGRES_PASSWORD = from $MY_PG_PASSWORD, required");
    expect(info).not.toContain("MY_PG_PASSWORD =");
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

  it("lists providers with credentials and metadata", () => {
    const plan = createPlan("my-app");
    plan.runtime.providers.push({
      name: "jira",
      type: "jira",
      url: "https://acme.atlassian.net",
      project: "PROJ",
      credentials: {
        token: { env: "JIRA_TOKEN" },
      },
      metadata: { team: "platform" },
    });

    const info = formatInfo(plan);
    expect(info).toContain("Providers:");
    expect(info).toContain("jira (jira, https://acme.atlassian.net, project PROJ)");
    expect(info).toContain("$JIRA_TOKEN");
    expect(info).toContain("team: platform");
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
    expect(md).toContain("postgresql://app@postgres:5432/myapp");
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
        username: { env: "DJANGO_API_USERNAME" },
        token: { env: "DJANGO_API_TOKEN" },
      },
    });

    const md = formatAgentsMd(plan);
    expect(md).toContain("## Endpoints");
    expect(md).toContain("### django-api");
    expect(md).toContain("Django REST API");
    expect(md).toContain("- URL: `http://localhost:8000`");
    expect(md).toContain("- Port: `8000`");
    expect(md).toContain("username: `$DJANGO_API_USERNAME (from environment)`");
    expect(md).toContain("token: `$DJANGO_API_TOKEN (from environment)`");
  });

  it("documents providers with URLs, projects, and credentials", () => {
    const plan = createPlan("my-app");
    plan.runtime.providers.push({
      name: "jira",
      type: "jira",
      url: "https://acme.atlassian.net",
      project: "PROJ",
      credentials: {
        token: { env: "JIRA_TOKEN" },
      },
      metadata: { team: "platform" },
    });

    const md = formatAgentsMd(plan);
    expect(md).toContain("## Providers");
    expect(md).toContain("### jira");
    expect(md).toContain("- Type: `jira`");
    expect(md).toContain("- URL: `https://acme.atlassian.net`");
    expect(md).toContain("- Project: `PROJ`");
    expect(md).toContain("$JIRA_TOKEN");
    expect(md).toContain("- team: `platform`");
  });

  it("documents Linear providers", () => {
    const plan = createPlan("my-app");
    plan.runtime.providers.push({
      name: "linear",
      type: "linear",
      url: "https://mcp.linear.app/mcp",
      project: "TEAM",
      credentials: {
        token: { env: "LINEAR_TOKEN" },
      },
    });

    const md = formatAgentsMd(plan);
    expect(md).toContain("### linear");
    expect(md).toContain("- Type: `linear`");
    expect(md).toContain("- Project: `TEAM`");
    expect(md).toContain("$LINEAR_TOKEN");
  });

  it("falls back to mcpUrl when url is absent", () => {
    const plan = createPlan("my-app");
    plan.runtime.providers.push({
      name: "sentry",
      type: "sentry",
      mcpUrl: "https://mcp.sentry.dev/mcp",
      credentials: { token: { env: "SENTRY_TOKEN" } },
    });

    const info = formatInfo(plan);
    expect(info).toContain("sentry (sentry, https://mcp.sentry.dev/mcp)");
    expect(info).toContain("$SENTRY_TOKEN");

    const md = formatAgentsMd(plan);
    expect(md).toContain("- URL: `https://mcp.sentry.dev/mcp`");
  });
});
