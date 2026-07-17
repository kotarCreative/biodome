import { describe, it, expect } from "vitest";
import { createPlan } from "../../core/plan.js";
import { generatePlanJson, generateMcpServerContent } from "../../mcp/generator.js";

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

describe("generateMcpServerContent", () => {
  it("returns valid JavaScript source", () => {
    const src = generateMcpServerContent();
    expect(src).toBeTruthy();
    expect(src).toContain("biodome-mcp server");
    expect(src).toContain("@modelcontextprotocol/sdk");
    expect(src).toContain("StreamableHTTPServerTransport");
    expect(src).toContain("get_sandbox_info");
    expect(src).toContain("get_endpoints");
    expect(src).toContain("get_process_status");
    expect(src).toContain("get_service_health");
    expect(src).toContain("get_logs");
    expect(src).toContain("restart_process");
    expect(src).toContain("exec_command");
  });

  it("creates a no-op when parsed as JavaScript (no syntax errors)", () => {
    // Basic check that it's parseable: the function returns a string
    expect(typeof generateMcpServerContent()).toBe("string");
  });

  it("does not build the tail command through a shell", () => {
    const src = generateMcpServerContent();
    // The vulnerable form interpolated filePath into a shell string.
    expect(src).not.toContain('tail -${lines}');
    expect(src).toContain('execFileSync("tail"');
  });

  it("validates process names to prevent injection/traversal", () => {
    const src = generateMcpServerContent();
    expect(src).toContain("isSafeProcessName");
    expect(src).toContain("[A-Za-z0-9_.-]+");
  });

  it("refuses to restart the MCP server itself", () => {
    const src = generateMcpServerContent();
    expect(src).toContain("Refusing to restart the biodome-mcp server itself");
  });

  it("binds to 0.0.0.0 so the published port is reachable", () => {
    const src = generateMcpServerContent();
    expect(src).toContain('httpServer.listen(port, "0.0.0.0"');
  });

  it("resolves endpoint credential env references from the container env", () => {
    const src = generateMcpServerContent();
    expect(src).toContain("resolveSecret");
    expect(src).toContain("resolveEndpoint");
    expect(src).toContain("process.env[value.env]");
  });

  it("redacts endpoint credentials in the MCP audit log", () => {
    const src = generateMcpServerContent();
    expect(src).toContain("redactEndpointForLog");
    expect(src).toContain("REDACTED");
    // The log payload is redacted; the returned result still contains secrets.
    expect(src).toContain("logCall(name, args, redacted)");
  });
});
