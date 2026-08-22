import { Schema } from "effect";
import {
  type AgentHarness,
  AgentHarnessSpecSchema,
  type AgentHarnessTelemetry,
  type ClaudeHarness,
  ClaudeHarnessSpecSchema,
  type CodexHarness,
  CodexHarnessSpecSchema,
  type PiHarness,
  PiHarnessSpecSchema,
  type Plan,
} from "../plan.js";
import type {
  AgentHarnessSpec,
  ClaudeHarnessSpec,
  CodexHarnessSpec,
  EnvSpec,
  LanguageOptions,
  PiHarnessSpec,
  ProcessSpec,
} from "../feature.js";
import { ValidationError } from "../errors.js";
import { mcpClientAuthFromToken } from "../mcp-client.js";

export interface HarnessPaths {
  logs: string;
  opencodeHomes: string;
  codexHomes: string;
}

export interface HarnessDependencies {
  addLanguage(name: string, options?: LanguageOptions): void;
  addAptPackage(name: string): void;
  addLanguageSnippet(snippet: string): void;
  addProcess(spec: ProcessSpec): void;
  addEnv(key: string, spec: EnvSpec): void;
  hasEnv(key: string): boolean;
}

type TelemetrySpec = {
  enabled?: boolean;
  path?: string;
  capturePayloads?: boolean;
};

function validatePort(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ValidationError({ message: `${label} must be an integer between 1 and 65535` });
  }
}

function telemetry(spec: TelemetrySpec | undefined, path: string): AgentHarnessTelemetry {
  return {
    enabled: spec?.enabled ?? true,
    path: spec?.path ?? path,
    capturePayloads: spec?.capturePayloads ?? false,
  };
}

export class HarnessBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly paths: HarnessPaths,
    private readonly dependencies: HarnessDependencies,
  ) {}

  addOpencodeHarness(spec: AgentHarnessSpec): void {
    const validated = Schema.decodeSync(AgentHarnessSpecSchema)(spec);
    if (this.plan.runtime.agentHarnesses.some((harness) => harness.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate agent harness name: ${validated.name}` });
    }

    const port = validated.port ?? 3002;
    validatePort(port, `Agent harness ${validated.name}: port`);
    const harness: AgentHarness = {
      name: validated.name,
      type: "opencode",
      port,
      mcpServers: validated.mcpServers ?? this.defaultMcpServers(),
      telemetry: telemetry(validated.telemetry, `${this.paths.logs}/opencode-events.jsonl`),
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.agentHarnesses.push(harness);

    this.dependencies.addLanguage("node", { version: "20" });
    this.dependencies.addAptPackage("curl");
    this.dependencies.addAptPackage("ca-certificates");
    // opencode ships as a self-contained compiled binary, so no separate bun
    // runtime is required. curl stays: the generated http healthcheck uses it.
    this.dependencies.addLanguageSnippet(
      "RUN --mount=type=cache,target=/root/.npm npm install -g opencode-ai",
    );
    this.dependencies.addProcess({
      name: `opencode-agent-${validated.name}`,
      command: ["sh", `${this.paths.opencodeHomes}/${validated.name}/start.sh`],
      port,
      healthCheck: { type: "http", url: `http://localhost:${port}/health` },
      environment: {
        HOME: `${this.paths.opencodeHomes}/${validated.name}`,
        OPENCODE_TELEMETRY_PATH: harness.telemetry.path,
      },
    });
  }

  addPiHarness(spec: PiHarnessSpec): void {
    const validated = Schema.decodeSync(PiHarnessSpecSchema)(spec);
    if (this.plan.runtime.piHarnesses.some((harness) => harness.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate Pi harness name: ${validated.name}` });
    }
    const harness: PiHarness = {
      name: validated.name,
      type: "pi",
      provider: validated.provider,
      model: validated.model,
      apiKey: validated.apiKey,
      tools: validated.tools ? [...validated.tools] : undefined,
      extensions: validated.extensions ? [...validated.extensions] : undefined,
      skills: validated.skills ? [...validated.skills] : undefined,
      prompts: validated.prompts ? [...validated.prompts] : undefined,
      themes: validated.themes ? [...validated.themes] : undefined,
      packages: validated.packages ? [...validated.packages] : undefined,
      telemetry: telemetry(
        validated.telemetry,
        `${this.paths.logs}/pi-${validated.name}-events.jsonl`,
      ),
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.piHarnesses.push(harness);

    this.dependencies.addLanguage("node", { version: "20" });
    this.dependencies.addLanguageSnippet(
      "RUN --mount=type=cache,target=/root/.npm npm install -g @earendil-works/pi-coding-agent",
    );
    this.addApiKeyEnv(harness.apiKey);
  }

  addCodexHarness(spec: CodexHarnessSpec): void {
    const validated = Schema.decodeSync(CodexHarnessSpecSchema)(spec);
    if (this.plan.runtime.codexHarnesses.some((harness) => harness.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate Codex harness name: ${validated.name}` });
    }
    const port = validated.port ?? 3003;
    validatePort(port, `Codex harness ${validated.name}: port`);
    const harness: CodexHarness = {
      name: validated.name,
      type: "codex",
      port,
      mcpServers: validated.mcpServers ?? this.defaultMcpServers(),
      apiKey: validated.apiKey,
      model: validated.model,
      telemetry: telemetry(
        validated.telemetry,
        `${this.paths.logs}/codex-${validated.name}-events.jsonl`,
      ),
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.codexHarnesses.push(harness);

    this.dependencies.addLanguage("node", { version: "20" });
    this.dependencies.addAptPackage("git");
    this.dependencies.addLanguageSnippet(
      "RUN --mount=type=cache,target=/root/.npm npm install -g @openai/codex",
    );
    this.dependencies.addProcess({
      name: `codex-agent-${validated.name}`,
      command: ["sh", `${this.paths.codexHomes}/${validated.name}/start.sh`],
      port,
      healthCheck: { type: "tcp", port },
      environment: {
        HOME: `${this.paths.codexHomes}/${validated.name}`,
        CODEX_BIODOME_TELEMETRY_PATH: harness.telemetry.path,
      },
      mergeEnv: false,
    });
    this.addApiKeyEnv(harness.apiKey);
  }

  addClaudeHarness(spec: ClaudeHarnessSpec): void {
    const validated = Schema.decodeSync(ClaudeHarnessSpecSchema)(spec);
    if (this.plan.runtime.claudeHarnesses.some((harness) => harness.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate Claude harness name: ${validated.name}` });
    }
    const harness: ClaudeHarness = {
      name: validated.name,
      type: "claude",
      apiKey: validated.apiKey,
      model: validated.model,
      tools: validated.tools ? [...validated.tools] : undefined,
      permissions: validated.permissions,
      telemetry: telemetry(
        validated.telemetry,
        `${this.paths.logs}/claude-${validated.name}-events.jsonl`,
      ),
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.claudeHarnesses.push(harness);

    this.dependencies.addLanguage("node", { version: "20" });
    this.dependencies.addAptPackage("git");
    this.dependencies.addLanguageSnippet(
      "RUN --mount=type=cache,target=/root/.npm npm install -g @anthropic-ai/claude-code",
    );
    this.addApiKeyEnv(harness.apiKey);
  }

  private addApiKeyEnv(apiKey: { env: string } | undefined): void {
    if (apiKey && !this.dependencies.hasEnv(apiKey.env)) {
      // The user may have declared this variable already (e.g. an AWS secret
      // ARN reference); their declaration wins, we only ensure one exists.
      this.dependencies.addEnv(apiKey.env, { from: { env: apiKey.env } });
    }
  }

  private defaultMcpServers(): AgentHarness["mcpServers"] {
    if (!this.plan.build.mcpEnabled) return {};
    const token = this.plan.build.mcpConfig.token;
    if (!token || typeof token === "string") return {};
    return {
      biodome: {
        url: `http://localhost:${this.plan.build.mcpPort}`,
        auth: mcpClientAuthFromToken(token),
      },
    };
  }
}
