import { ValidationError } from "../errors.js";
import type { EnvSpec, LanguageOptions, ProcessSpec } from "../feature.js";
import type { Plan } from "../plan.js";

export interface McpOptions {
  // Required when MCP is enabled; enforced by `configure`.
  token?: { env: string };
  allowExec?: boolean;
  allowProcessControl?: boolean;
  commandTimeoutMs?: number;
  commandStdoutMaxBytes?: number;
  commandStderrMaxBytes?: number;
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
  addEnv: (key: string, spec: EnvSpec) => void;
  volumeCredentialEnvironment: () => Record<string, string>;
  providerCredentialEnvironment: () => Record<string, string>;
}

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class McpBuilder {
  private tokenStrengthAdvised = false;

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

    const token = options.token;
    if (token === undefined) {
      throw new ValidationError({
        message: 'MCP token is required when MCP is enabled ({ env: "VAR" })',
      });
    }
    if (typeof token === "string") {
      throw new ValidationError({
        message: 'MCP token must be an environment variable reference ({ env: "VAR" })',
      });
    }
    if (!ENV_VAR_NAME_PATTERN.test(token.env)) {
      throw new ValidationError({
        message: `MCP token references an invalid environment variable: "${token.env}"`,
      });
    }
    this.plan.build.mcpConfig.token = { env: token.env };

    if (options.allowExec !== undefined) this.plan.build.mcpConfig.allowExec = options.allowExec;
    if (options.allowProcessControl !== undefined) {
      this.plan.build.mcpConfig.allowProcessControl = options.allowProcessControl;
    }
    if (options.commandTimeoutMs !== undefined) {
      this.plan.build.mcpConfig.commandTimeoutMs = options.commandTimeoutMs;
    }
    if (options.commandStdoutMaxBytes !== undefined) {
      this.plan.build.mcpConfig.commandStdoutMaxBytes = options.commandStdoutMaxBytes;
    }
    if (options.commandStderrMaxBytes !== undefined) {
      this.plan.build.mcpConfig.commandStderrMaxBytes = options.commandStderrMaxBytes;
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
    const configuredToken = this.plan.build.mcpConfig.token;
    if (configuredToken && typeof configuredToken === "object") {
      environment[configuredToken.env] = `\${${configuredToken.env}}`;
      // Declare the token as a passthrough env var so the compose dev service
      // (and every supervised process) receives the value from the host.
      if (!this.plan.runtime.envVars.some((entry) => entry.key === configuredToken.env)) {
        this.capabilities.addEnv(configuredToken.env, { from: { env: configuredToken.env } });
      }
      // The token value is not known at plan time, so advise once per build
      // that it must be high-entropy: it authenticates every MCP call,
      // including exec_command when allowExec is enabled.
      if (!this.tokenStrengthAdvised) {
        this.tokenStrengthAdvised = true;
        console.warn(
          `[biodome] MCP token env var "${configuredToken.env}" gates exec_command; set it to a high-entropy random secret`,
        );
      }
    }

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
      identity: "mcp",
    });
  }
}
