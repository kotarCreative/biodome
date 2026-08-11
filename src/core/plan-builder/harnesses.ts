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
      mcpServers: validated.mcpServers ?? {
        biodome: { url: `http://localhost:${this.plan.build.mcpPort}` },
      },
      telemetry: telemetry(validated.telemetry, `${this.paths.logs}/opencode-events.jsonl`),
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.agentHarnesses.push(harness);

    this.dependencies.addLanguage("node", { version: "20" });
    this.dependencies.addAptPackage("curl");
    this.dependencies.addAptPackage("ca-certificates");
    this.dependencies.addAptPackage("unzip");
    this.dependencies.addLanguageSnippet("RUN npm install -g opencode-ai");
    this.dependencies.addLanguageSnippet(
      "RUN curl -fsSL -o /tmp/bun-install.sh https://bun.sh/install && bash /tmp/bun-install.sh && rm /tmp/bun-install.sh && ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
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
    this.rejectLiteralApiKey("Pi", validated.name, validated.apiKey);

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
    this.dependencies.addLanguageSnippet("RUN npm install -g @earendil-works/pi-coding-agent");
    this.addApiKeyEnv(harness.apiKey);
  }

  addCodexHarness(spec: CodexHarnessSpec): void {
    const validated = Schema.decodeSync(CodexHarnessSpecSchema)(spec);
    if (this.plan.runtime.codexHarnesses.some((harness) => harness.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate Codex harness name: ${validated.name}` });
    }
    this.rejectLiteralApiKey("Codex", validated.name, validated.apiKey);

    const port = validated.port ?? 3003;
    validatePort(port, `Codex harness ${validated.name}: port`);
    const harness: CodexHarness = {
      name: validated.name,
      type: "codex",
      port,
      mcpServers: validated.mcpServers ?? {
        biodome: { url: `http://localhost:${this.plan.build.mcpPort}` },
      },
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
    this.dependencies.addLanguageSnippet("RUN npm install -g @openai/codex");
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
    this.rejectLiteralApiKey("Claude", validated.name, validated.apiKey);

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
    this.dependencies.addLanguageSnippet("RUN npm install -g @anthropic-ai/claude-code");
    this.addApiKeyEnv(harness.apiKey);
  }

  private rejectLiteralApiKey(
    family: "Pi" | "Codex" | "Claude",
    name: string,
    apiKey: string | { env: string } | undefined,
  ): void {
    if (typeof apiKey === "string") {
      throw new ValidationError({
        message: `${family} harness ${name}: apiKey must be an environment reference ({ env: "VAR" }), not a literal string`,
      });
    }
  }

  private addApiKeyEnv(apiKey: string | { env: string } | undefined): void {
    if (apiKey && typeof apiKey === "object" && "env" in apiKey) {
      this.dependencies.addEnv(apiKey.env, { from: { env: apiKey.env } });
    }
  }
}
