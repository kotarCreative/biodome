import { ValidationError } from "../errors.js";
import type { LanguageOptions, ProcessSpec, SecretValue } from "../feature.js";
import type { Plan } from "../plan.js";

export interface McpOptions {
  token?: SecretValue;
  allowExec?: boolean;
  allowProcessControl?: boolean;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxListEntries?: number;
  providerConnectTimeoutMs?: number;
  providerRequestTimeoutMs?: number;
  providerCatalogConcurrency?: number;
}

interface McpLayout {
  logs: string;
  mcpPlan: string;
  mcpServer: string;
}

interface McpCapabilities {
  addLanguage: (name: string, options?: LanguageOptions) => void;
  addProcess: (spec: ProcessSpec) => void;
  volumeCredentialEnvironment: () => Record<string, string>;
  providerCredentialEnvironment: () => Record<string, string>;
}

export class McpBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly layout: McpLayout,
    private readonly capabilities: McpCapabilities,
  ) {}

  configure(port: number, options: McpOptions = {}): void {
    this.plan.build.mcpEnabled = true;
    this.plan.build.mcpPort = port;
    this.plan.build.mcpConfig.enabled = true;
    this.plan.build.mcpConfig.port = port;

    if (options.token) {
      if (typeof options.token === "string") {
        throw new ValidationError({
          message: 'MCP token must be an environment variable reference ({ env: "VAR" })',
        });
      }
      this.plan.build.mcpConfig.token = { env: options.token.env };
    }
    if (options.allowExec !== undefined) this.plan.build.mcpConfig.allowExec = options.allowExec;
    if (options.allowProcessControl !== undefined) {
      this.plan.build.mcpConfig.allowProcessControl = options.allowProcessControl;
    }
    if (options.maxReadBytes !== undefined)
      this.plan.build.mcpConfig.maxReadBytes = options.maxReadBytes;
    if (options.maxWriteBytes !== undefined) {
      this.plan.build.mcpConfig.maxWriteBytes = options.maxWriteBytes;
    }
    if (options.maxListEntries !== undefined) {
      this.plan.build.mcpConfig.maxListEntries = options.maxListEntries;
    }
    if (options.providerConnectTimeoutMs !== undefined) {
      this.plan.build.mcpConfig.providerConnectTimeoutMs = options.providerConnectTimeoutMs;
    }
    if (options.providerRequestTimeoutMs !== undefined) {
      this.plan.build.mcpConfig.providerRequestTimeoutMs = options.providerRequestTimeoutMs;
    }
    if (options.providerCatalogConcurrency !== undefined) {
      this.plan.build.mcpConfig.providerCatalogConcurrency = options.providerCatalogConcurrency;
    }

    if (!this.plan.build.languageRequests.some((request) => request.name === "node")) {
      this.capabilities.addLanguage("node", { version: "20" });
    }

    const environment = {
      ...this.capabilities.volumeCredentialEnvironment(),
      ...this.capabilities.providerCredentialEnvironment(),
    };
    const token = this.plan.build.mcpConfig.token;
    if (token && typeof token === "object") environment[token.env] = `\${${token.env}}`;

    this.capabilities.addProcess({
      name: "biodome-mcp",
      command: [
        "node",
        this.layout.mcpServer,
        "--port",
        String(port),
        "--plan",
        this.layout.mcpPlan,
      ],
      port,
      healthCheck: { type: "http", url: `http://localhost:${port}/health` },
      environment: {
        ...environment,
        MCP_EVENTS_LOG: `${this.layout.logs}/mcp-events.jsonl`,
      },
      mergeEnv: false,
    });
  }
}
