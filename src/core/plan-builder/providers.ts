import { Schema } from "effect";
import {
  EndpointSpecSchema,
  type LlmProvider,
  LlmProviderSpecSchema,
  type Plan,
  type Provider,
  ProviderSpecSchema,
} from "../plan.js";
import type {
  EndpointSpec,
  EnvSpec,
  GithubProviderSpec,
  JiraProviderSpec,
  LinearProviderSpec,
  LlmProviderSpec,
  McpProviderSpec,
  ProviderSpec,
  SentryProviderSpec,
  SlackProviderSpec,
} from "../feature.js";
import { ValidationError } from "../errors.js";

type AddEnv = (key: string, spec: EnvSpec) => void;

function validatePort(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ValidationError({ message: `${label} must be an integer between 1 and 65535` });
  }
}

function validateMetadata(env: Record<string, unknown>, label: string): void {
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new ValidationError({ message: `${label} must be a record of strings` });
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new ValidationError({ message: `${label}.${key} must be a string` });
    }
  }
}

export class ProviderBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly addEnv: AddEnv,
  ) {}

  addEndpoint(spec: EndpointSpec): void {
    const validated = Schema.decodeSync(EndpointSpecSchema)(spec);
    if (validated.port !== undefined) {
      validatePort(validated.port, `Endpoint ${validated.name}: port`);
    }
    if (validated.metadata) {
      validateMetadata(validated.metadata, `Endpoint ${validated.name}: metadata`);
    }
    if (this.plan.runtime.endpoints.some((endpoint) => endpoint.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate endpoint name: ${validated.name}` });
    }

    this.plan.runtime.endpoints.push({
      name: validated.name,
      description: validated.description,
      url: validated.url,
      port: validated.port,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
      metadata: validated.metadata ? { ...validated.metadata } : undefined,
    });
  }

  addProvider(spec: ProviderSpec): void {
    const validated = Schema.decodeSync(ProviderSpecSchema)(spec);
    if (validated.metadata) {
      validateMetadata(validated.metadata, `Provider ${validated.name}: metadata`);
    }
    if (this.plan.runtime.providers.some((provider) => provider.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate provider name: ${validated.name}` });
    }
    if (validated.credentials) {
      for (const [key, value] of Object.entries(validated.credentials)) {
        if (typeof value === "string") {
          throw new ValidationError({
            message: `Provider ${validated.name}: credentials.${key} must be an environment reference ({ env: "VAR" }), not a literal string`,
          });
        }
      }
    }

    const provider: Provider = {
      name: validated.name,
      type: validated.type,
      url: validated.url,
      project: validated.project,
      mcpUrl: validated.mcpUrl,
      authHeader: validated.authHeader,
      authScheme: validated.authScheme,
      authCredential: validated.authCredential,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
      metadata: validated.metadata ? { ...validated.metadata } : undefined,
    };
    this.plan.runtime.providers.push(provider);
  }

  addMcpProvider(spec: McpProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "MCP provider requires a name" });
    if (!spec.mcpUrl) {
      throw new ValidationError({ message: `Provider ${spec.name}: mcpUrl is required` });
    }
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addProvider({
      name: spec.name,
      type: spec.type,
      mcpUrl: spec.mcpUrl,
      authHeader: spec.authHeader ?? "Authorization",
      authScheme: spec.authScheme ?? "Bearer ",
      authCredential: "token",
      project: spec.project,
      credentials: { token: spec.credentials.token },
      metadata: spec.metadata,
    });
  }

  addJiraProvider(spec: JiraProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "Jira provider requires a name" });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Jira provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "jira",
      mcpUrl: spec.mcpUrl ?? "https://mcp.atlassian.com/v1/mcp/authv2",
      project: spec.project,
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addLinearProvider(spec: LinearProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "Linear provider requires a name" });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Linear provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "linear",
      mcpUrl: spec.mcpUrl ?? "https://mcp.linear.app/mcp",
      project: spec.team,
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addSentryProvider(spec: SentryProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "Sentry provider requires a name" });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Sentry provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "sentry",
      mcpUrl: spec.mcpUrl ?? "https://mcp.sentry.dev/mcp",
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addSlackProvider(spec: SlackProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "Slack provider requires a name" });
    if (!spec.mcpUrl) {
      throw new ValidationError({ message: `Slack provider ${spec.name}: mcpUrl is required` });
    }
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Slack provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "slack",
      mcpUrl: spec.mcpUrl,
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addGithubProvider(spec: GithubProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "GitHub provider requires a name" });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `GitHub provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "github",
      mcpUrl: spec.mcpUrl ?? "https://api.githubcopilot.com/mcp/",
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addLlmProvider(spec: LlmProviderSpec): void {
    const validated = Schema.decodeSync(LlmProviderSpecSchema)(spec);
    if (this.plan.runtime.llmProviders.some((provider) => provider.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate LLM provider name: ${validated.name}` });
    }

    const provider: LlmProvider = {
      name: validated.name,
      npm: validated.npm,
      displayName: validated.displayName,
      options: validated.options ? { ...validated.options } : {},
      models: validated.models ? { ...validated.models } : {},
    };
    for (const [key, value] of Object.entries(provider.options)) {
      if (typeof value === "string" && key.toLowerCase().includes("key")) {
        throw new ValidationError({
          message: `LLM provider ${validated.name}: option "${key}" looks like a credential and must be an environment reference ({ env: "VAR" }), not a literal string`,
        });
      }
    }
    for (const value of Object.values(provider.options)) {
      if (value !== undefined && typeof value === "object" && "env" in value) {
        this.addEnv(value.env, { from: { env: value.env } });
      }
    }
    this.plan.runtime.llmProviders.push(provider);
  }

  mcpCredentialEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const provider of this.plan.runtime.providers) {
      if (!provider.credentials) continue;
      for (const value of Object.values(provider.credentials)) {
        if (typeof value === "string") continue;
        environment[value.env] = `\${${value.env}}`;
      }
    }
    return environment;
  }
}
