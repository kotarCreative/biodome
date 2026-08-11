import { describe, expect, it } from "vitest";
import type { ProcessSpec } from "../../../core/feature.js";
import { createPlan } from "../../../core/plan.js";
import { McpBuilder } from "../../../core/plan-builder/mcp.js";

function makeBuilder(
  options: {
    volumeEnvironment?: Record<string, string>;
    providerEnvironment?: Record<string, string>;
    addProcess?: (spec: ProcessSpec) => void;
  } = {},
) {
  const plan = createPlan("test");
  const languages: Array<{ name: string; version?: string }> = [];
  const processes: ProcessSpec[] = [];
  const envVars: Array<{ key: string }> = [];
  const builder = new McpBuilder(
    plan,
    {
      logs: "/workspace/.biodome-build/logs",
      mcpPlan: "/workspace/.biodome-build/plan.json",
      mcpServer: "/workspace/.biodome-build/mcp/server.js",
    },
    {
      addLanguage: (name, languageOptions) => languages.push({ name, ...languageOptions }),
      addProcess: options.addProcess ?? ((spec) => processes.push(spec)),
      addEnv: (key) => envVars.push({ key }),
      volumeCredentialEnvironment: () => ({ ...options.volumeEnvironment }),
      providerCredentialEnvironment: () => ({ ...options.providerEnvironment }),
    },
  );
  return { builder, languages, plan, processes, envVars };
}

describe("McpBuilder", () => {
  it("sets MCP defaults, requests Node 20, and creates the isolated daemon", () => {
    const { builder, languages, plan, processes, envVars } = makeBuilder();

    builder.configure(3005, { token: { env: "MCP_TOKEN" } });

    expect(plan.build.mcpEnabled).toBe(true);
    expect(plan.build.mcpPort).toBe(3005);
    expect(plan.build.mcpConfig).toMatchObject({ enabled: true, port: 3005 });
    expect(languages).toEqual([{ name: "node", version: "20" }]);
    expect(processes).toEqual([
      {
        name: "biodome-mcp",
        command: [
          "node",
          "/workspace/.biodome-build/mcp/server.js",
          "--port",
          "3005",
          "--plan",
          "/workspace/.biodome-build/plan.json",
        ],
        port: 3005,
        healthCheck: { type: "http", url: "http://localhost:3005/health" },
        environment: {
          MCP_TOKEN: "${MCP_TOKEN}",
          MCP_EVENTS_LOG: "/workspace/.biodome-build/logs/mcp-events.jsonl",
        },
        mergeEnv: false,
      },
    ]);
    expect(envVars).toContainEqual({ key: "MCP_TOKEN" });
    expect(plan.runtime.environment).toEqual({});
  });

  it("applies every defined option without changing unspecified defaults", () => {
    const { builder, plan } = makeBuilder();

    builder.configure(3001, {
      token: { env: "MCP_TOKEN" },
      allowExec: true,
      allowProcessControl: true,
      maxReadBytes: 1,
      maxWriteBytes: 2,
      maxListEntries: 3,
      providerConnectTimeoutMs: 4,
      providerRequestTimeoutMs: 5,
      providerCatalogConcurrency: 6,
    });

    expect(plan.build.mcpConfig).toEqual({
      enabled: true,
      port: 3001,
      token: { env: "MCP_TOKEN" },
      allowExec: true,
      allowProcessControl: true,
      maxReadBytes: 1,
      maxWriteBytes: 2,
      maxListEntries: 3,
      providerConnectTimeoutMs: 4,
      providerRequestTimeoutMs: 5,
      providerCatalogConcurrency: 6,
    });
  });

  it("rejects a missing token when MCP is enabled", () => {
    const { builder, processes } = makeBuilder();

    expect(() => builder.configure(3001)).toThrow(
      'MCP token is required when MCP is enabled ({ env: "VAR" })',
    );
    expect(processes).toEqual([]);
  });

  it("rejects literal tokens after setting MCP flags", () => {
    const { builder, languages, plan, processes } = makeBuilder();

    expect(() => builder.configure(3001, { token: "secret" })).toThrow(
      "MCP token must be an environment variable reference",
    );
    expect(plan.build.mcpEnabled).toBe(true);
    expect(plan.build.mcpConfig.enabled).toBe(true);
    expect(languages).toEqual([]);
    expect(processes).toEqual([]);
  });

  it("preserves an existing Node request", () => {
    const { builder, languages, plan } = makeBuilder();
    plan.build.languageRequests.push({ name: "node", options: { version: "22" } });

    builder.configure(3001, { token: { env: "MCP_TOKEN" } });

    expect(languages).toEqual([]);
  });

  it("merges volume, provider, and token credentials in precedence order", () => {
    const { builder, processes } = makeBuilder({
      volumeEnvironment: { VOLUME_TOKEN: "${VOLUME_TOKEN}", CONFLICT: "volume" },
      providerEnvironment: {
        PROVIDER_TOKEN: "${PROVIDER_TOKEN}",
        CONFLICT: "provider",
        TOKEN: "provider",
      },
    });

    builder.configure(3001, { token: { env: "TOKEN" } });

    expect(processes[0].environment).toMatchObject({
      VOLUME_TOKEN: "${VOLUME_TOKEN}",
      PROVIDER_TOKEN: "${PROVIDER_TOKEN}",
      CONFLICT: "provider",
      TOKEN: "${TOKEN}",
    });
    expect(processes[0].mergeEnv).toBe(false);
  });

  it("rejects a harness that cannot send authorization headers to biodome MCP", () => {
    const { builder, plan } = makeBuilder();
    plan.runtime.codexHarnesses.push({
      name: "legacy",
      type: "pi",
      port: 3003,
      mcpServers: { biodome: { url: "http://localhost:3001" } },
      model: "gpt-5.6",
      telemetry: { enabled: true, path: "/workspace/events.jsonl" },
      config: {},
    });

    expect(() => builder.configure(3001, { token: { env: "MCP_TOKEN" } })).toThrow(
      'harness "legacy" (type "pi") cannot send authorization headers',
    );
  });

  it("propagates process failures after recording MCP and Node contributions", () => {
    const { builder, languages, plan } = makeBuilder({
      addProcess: () => {
        throw new Error("duplicate process");
      },
    });

    expect(() => builder.configure(3001, { token: { env: "MCP_TOKEN" } })).toThrow(
      "duplicate process",
    );
    expect(plan.build.mcpEnabled).toBe(true);
    expect(languages).toEqual([{ name: "node", version: "20" }]);
  });
});
