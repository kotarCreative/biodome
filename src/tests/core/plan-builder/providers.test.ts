import { describe, expect, it } from "vitest";
import type { EnvSpec } from "../../../core/feature.js";
import { createPlan, type SecretReference } from "../../../core/plan.js";
import { ProviderBuilder } from "../../../core/plan-builder/providers.js";

function makeBuilder(
  addEnv: (key: string, spec: EnvSpec) => void = () => undefined,
  hasEnv: (key: string) => boolean = () => false,
) {
  const plan = createPlan("test");
  return { plan, builder: new ProviderBuilder(plan, addEnv, hasEnv) };
}

describe("ProviderBuilder", () => {
  it("normalizes endpoints and defensively copies their mutable fields", () => {
    const { builder, plan } = makeBuilder();
    const credentials = { password: { env: "API_PASSWORD" }, token: { env: "API_TOKEN" } };
    const metadata = { framework: "django" };

    builder.addEndpoint({
      name: "api",
      description: "Django API",
      url: "http://localhost:8000",
      port: 8000,
      credentials,
      metadata,
    });
    credentials.password = { env: "CHANGED" };
    metadata.framework = "flask";

    expect(plan.runtime.endpoints).toEqual([
      {
        name: "api",
        description: "Django API",
        url: "http://localhost:8000",
        port: 8000,
        credentials: { password: { env: "API_PASSWORD" }, token: { env: "API_TOKEN" } },
        metadata: { framework: "django" },
      },
    ]);
  });

  it("rejects invalid, duplicate, and malformed endpoint declarations", () => {
    const { builder } = makeBuilder();
    builder.addEndpoint({ name: "api" });

    expect(() => builder.addEndpoint({ name: "api" })).toThrow(/Duplicate endpoint name/);
    expect(() => builder.addEndpoint({ name: "worker", port: 70000 })).toThrow(
      /integer between 1 and 65535/,
    );
    expect(() =>
      builder.addEndpoint({ name: "secret", credentials: { token: { env: "" } } }),
    ).toThrow();
  });

  it("normalizes generic providers and rejects literal credentials and duplicate names", () => {
    const { builder, plan } = makeBuilder();
    const credentials = { token: { env: "GITHUB_TOKEN" } };
    const metadata = { org: "acme" };

    builder.addProvider({
      name: "github",
      type: "github",
      url: "https://api.github.com",
      credentials,
      metadata,
    });
    metadata.org = "other";

    expect(plan.runtime.providers[0]).toMatchObject({
      name: "github",
      type: "github",
      url: "https://api.github.com",
      credentials,
      metadata: { org: "acme" },
    });
    expect(() => builder.addProvider({ name: "github", type: "github" })).toThrow(
      /Duplicate provider name/,
    );
    expect(() =>
      builder.addProvider({
        name: "literal",
        type: "custom",
        credentials: { token: "secret" as unknown as SecretReference },
      }),
    ).toThrow();
  });

  it("normalizes MCP authorization defaults and derives its isolated credential environment", () => {
    const { builder, plan } = makeBuilder();
    builder.addMcpProvider({
      name: "custom",
      type: "custom",
      mcpUrl: "https://example.com/mcp",
      credentials: { token: { env: "CUSTOM_TOKEN" } },
    });

    expect(plan.runtime.providers[0]).toMatchObject({
      authHeader: "Authorization",
      authScheme: "Bearer ",
      authCredential: "token",
    });
    expect(builder.mcpCredentialEnvironment()).toEqual({ CUSTOM_TOKEN: "${CUSTOM_TOKEN}" });
    expect(plan.runtime.environment).toEqual({});
    expect(() =>
      builder.addMcpProvider({
        name: "missing-url",
        type: "custom",
        mcpUrl: "",
        credentials: { token: { env: "TOKEN" } },
      }),
    ).toThrow(/mcpUrl is required/);
    expect(() =>
      builder.addMcpProvider({
        name: "missing-token",
        type: "custom",
        mcpUrl: "https://example.com/mcp",
        credentials: { token: "" as unknown as SecretReference },
      }),
    ).toThrow(/credentials.token is required/);
  });

  it("preserves vendor defaults and Linear's team scope mapping", () => {
    const { builder, plan } = makeBuilder();
    const token = { token: { env: "TOKEN" } };

    builder.addJiraProvider({ name: "jira", credentials: token });
    builder.addLinearProvider({ name: "linear", team: "TEAM", credentials: token });
    builder.addSentryProvider({ name: "sentry", credentials: token });
    builder.addSlackProvider({
      name: "slack",
      mcpUrl: "https://slack.example/mcp",
      credentials: token,
    });
    builder.addGithubProvider({ name: "github", credentials: token });

    expect(plan.runtime.providers).toMatchObject([
      { type: "jira", mcpUrl: "https://mcp.atlassian.com/v1/mcp/authv2" },
      { type: "linear", mcpUrl: "https://mcp.linear.app/mcp", project: "TEAM" },
      { type: "sentry", mcpUrl: "https://mcp.sentry.dev/mcp" },
      { type: "slack", mcpUrl: "https://slack.example/mcp" },
      { type: "github", mcpUrl: "https://api.githubcopilot.com/mcp/" },
    ]);
    expect(() =>
      builder.addSlackProvider({ name: "invalid", mcpUrl: "", credentials: token }),
    ).toThrow(/mcpUrl is required/);
  });

  it("normalizes LLM providers and declares credential references through the environment capability", () => {
    const declarations: Array<{ key: string; spec: EnvSpec }> = [];
    const { builder, plan } = makeBuilder((key, spec) => declarations.push({ key, spec }));
    const options = { baseURL: "http://localhost:2877/v1", apiKey: { env: "LMSTUDIO_API_KEY" } };
    const models: Record<string, { name?: string }> = { "local-model": { name: "Local Model" } };

    builder.addLlmProvider({
      name: "lmstudio",
      npm: "@ai-sdk/openai-compatible",
      displayName: "LM Studio",
      options,
      models,
    });
    models["another-model"] = { name: "Another Model" };

    expect(plan.runtime.llmProviders[0]).toMatchObject({
      name: "lmstudio",
      npm: "@ai-sdk/openai-compatible",
      displayName: "LM Studio",
      options,
      models: { "local-model": { name: "Local Model" } },
    });
    expect(declarations).toEqual([
      { key: "LMSTUDIO_API_KEY", spec: { from: { env: "LMSTUDIO_API_KEY" } } },
    ]);
    expect(() => builder.addLlmProvider({ name: "lmstudio" })).toThrow(
      /Duplicate LLM provider name/,
    );
    expect(() =>
      builder.addLlmProvider({ name: "literal", options: { apiKey: "secret" } }),
    ).toThrow(/must be an environment reference/);
  });

  it("keeps LLM and external provider names in separate registries", () => {
    const { builder, plan } = makeBuilder();

    builder.addProvider({ name: "shared", type: "custom" });
    builder.addLlmProvider({ name: "shared" });

    expect(plan.runtime.providers).toHaveLength(1);
    expect(plan.runtime.llmProviders).toHaveLength(1);
  });

  it("skips the credential env declaration when the variable is already declared", () => {
    const declarations: Array<{ key: string; spec: EnvSpec }> = [];
    // e.g. the user declared an AWS secret ARN-backed passthrough themselves.
    const { plan, builder } = makeBuilder(
      (key, spec) => declarations.push({ key, spec }),
      (key) => key === "LMSTUDIO_API_KEY",
    );

    builder.addLlmProvider({
      name: "lmstudio",
      options: { apiKey: { env: "LMSTUDIO_API_KEY" } },
      models: {},
    });

    expect(declarations).toEqual([]);
    expect(plan.runtime.llmProviders[0].options).toEqual({
      apiKey: { env: "LMSTUDIO_API_KEY" },
    });
  });
});
