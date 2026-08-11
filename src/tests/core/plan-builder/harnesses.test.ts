import { describe, expect, it } from "vitest";
import type { EnvSpec, LanguageOptions, ProcessSpec } from "../../../core/feature.js";
import { createPlan } from "../../../core/plan.js";
import { type HarnessDependencies, HarnessBuilder } from "../../../core/plan-builder/harnesses.js";

function makeBuilder(overrides: Partial<HarnessDependencies> = {}) {
  const plan = createPlan("test");
  plan.build.mcpPort = 3100;
  const languages: Array<{ name: string; options?: LanguageOptions }> = [];
  const packages: string[] = [];
  const snippets: string[] = [];
  const processes: ProcessSpec[] = [];
  const environments: Array<{ key: string; spec: EnvSpec }> = [];
  const dependencies: HarnessDependencies = {
    addLanguage: (name, options) => languages.push({ name, options }),
    addAptPackage: (name) => packages.push(name),
    addLanguageSnippet: (snippet) => snippets.push(snippet),
    addProcess: (spec) => processes.push(spec),
    addEnv: (key, spec) => environments.push({ key, spec }),
    ...overrides,
  };
  return {
    plan,
    languages,
    packages,
    snippets,
    processes,
    environments,
    builder: new HarnessBuilder(
      plan,
      {
        logs: "/workspace/.biodome-build/logs",
        opencodeHomes: "/workspace/.biodome-build/opencode-homes",
        codexHomes: "/workspace/.biodome-build/codex-homes",
      },
      dependencies,
    ),
  };
}

describe("HarnessBuilder", () => {
  it("normalizes OpenCode defaults and contributes its complete daemon dependencies", () => {
    const { builder, languages, packages, plan, processes, snippets } = makeBuilder();
    builder.addOpencodeHarness({ name: "agent" });

    expect(plan.runtime.agentHarnesses).toEqual([
      {
        name: "agent",
        type: "opencode",
        port: 3002,
        mcpServers: {},
        telemetry: {
          enabled: true,
          path: "/workspace/.biodome-build/logs/opencode-events.jsonl",
          capturePayloads: false,
        },
        config: {},
      },
    ]);
    expect(languages).toEqual([{ name: "node", options: { version: "20" } }]);
    expect(packages).toEqual(["curl", "ca-certificates", "unzip"]);
    expect(snippets).toEqual([
      "RUN npm install -g opencode-ai",
      expect.stringContaining("https://bun.sh/install"),
    ]);
    expect(processes).toEqual([
      {
        name: "opencode-agent-agent",
        command: ["sh", "/workspace/.biodome-build/opencode-homes/agent/start.sh"],
        port: 3002,
        healthCheck: { type: "http", url: "http://localhost:3002/health" },
        environment: {
          HOME: "/workspace/.biodome-build/opencode-homes/agent",
          OPENCODE_TELEMETRY_PATH: "/workspace/.biodome-build/logs/opencode-events.jsonl",
        },
      },
    ]);
  });

  it("preserves explicit OpenCode MCP maps and rejects duplicate or invalid declarations", () => {
    const { builder, plan } = makeBuilder();
    builder.addOpencodeHarness({
      name: "agent",
      port: 4000,
      mcpServers: { custom: { url: "http://localhost:5000" } },
    });
    plan.build.mcpPort = 3200;

    expect(plan.runtime.agentHarnesses[0]).toMatchObject({
      port: 4000,
      mcpServers: { custom: { url: "http://localhost:5000" } },
    });
    builder.addOpencodeHarness({ name: "no-mcp", mcpServers: {} });
    expect(plan.runtime.agentHarnesses[1].mcpServers).toEqual({});
    expect(() => builder.addOpencodeHarness({ name: "agent" })).toThrow(
      /Duplicate agent harness name/,
    );
    expect(() => builder.addOpencodeHarness({ name: "invalid", port: 70000 })).toThrow(
      /integer between 1 and 65535/,
    );
  });

  it("adds authenticated Biodome MCP only when MCP is enabled", () => {
    const { builder, plan } = makeBuilder();
    plan.build.mcpEnabled = true;
    plan.build.mcpConfig.token = { env: "MCP_TOKEN" };

    builder.addOpencodeHarness({ name: "agent" });

    expect(plan.runtime.agentHarnesses[0].mcpServers).toEqual({
      biodome: {
        url: "http://localhost:3100",
        auth: {
          header: "Authorization",
          env: "MCP_TOKEN",
          value: "Bearer ${MCP_TOKEN}",
        },
      },
    });
  });

  it("normalizes Pi resources, copies arrays, and declares API-key environment references", () => {
    const { builder, environments, languages, plan, processes, snippets } = makeBuilder();
    const tools = ["read", "bash"];
    builder.addPiHarness({
      name: "coder",
      provider: "anthropic",
      model: "claude-sonnet",
      apiKey: { env: "ANTHROPIC_API_KEY" },
      tools,
      extensions: ["/workspace/ext.ts"],
      skills: ["/workspace/skills"],
      prompts: ["/workspace/prompts"],
      themes: ["dark"],
      packages: ["pi-skills"],
      config: { color: "blue" },
    });
    tools.push("edit");

    expect(plan.runtime.piHarnesses[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet",
      tools: ["read", "bash"],
      extensions: ["/workspace/ext.ts"],
      skills: ["/workspace/skills"],
      prompts: ["/workspace/prompts"],
      themes: ["dark"],
      packages: ["pi-skills"],
      telemetry: {
        enabled: true,
        path: "/workspace/.biodome-build/logs/pi-coder-events.jsonl",
        capturePayloads: false,
      },
    });
    expect(languages).toEqual([{ name: "node", options: { version: "20" } }]);
    expect(snippets).toEqual(["RUN npm install -g @earendil-works/pi-coding-agent"]);
    expect(environments).toEqual([
      { key: "ANTHROPIC_API_KEY", spec: { from: { env: "ANTHROPIC_API_KEY" } } },
    ]);
    expect(processes).toEqual([]);
    expect(() => builder.addPiHarness({ name: "coder" })).toThrow(/Duplicate Pi harness name/);
    expect(() => builder.addPiHarness({ name: "literal", apiKey: "secret" })).toThrow(
      /must be an environment reference/,
    );
  });

  it("normalizes Codex defaults and contributes an isolated daemon process", () => {
    const { builder, environments, languages, packages, plan, processes, snippets } = makeBuilder();
    builder.addCodexHarness({ name: "coder", apiKey: { env: "OPENAI_API_KEY" } });
    plan.build.mcpPort = 3200;

    expect(plan.runtime.codexHarnesses[0]).toMatchObject({
      port: 3003,
      mcpServers: {},
      telemetry: {
        enabled: true,
        path: "/workspace/.biodome-build/logs/codex-coder-events.jsonl",
        capturePayloads: false,
      },
    });
    expect(languages).toEqual([{ name: "node", options: { version: "20" } }]);
    expect(packages).toEqual(["git"]);
    expect(snippets).toEqual(["RUN npm install -g @openai/codex"]);
    expect(processes).toEqual([
      {
        name: "codex-agent-coder",
        command: ["sh", "/workspace/.biodome-build/codex-homes/coder/start.sh"],
        port: 3003,
        healthCheck: { type: "tcp", port: 3003 },
        environment: {
          HOME: "/workspace/.biodome-build/codex-homes/coder",
          CODEX_BIODOME_TELEMETRY_PATH: "/workspace/.biodome-build/logs/codex-coder-events.jsonl",
        },
        mergeEnv: false,
      },
    ]);
    expect(environments).toEqual([
      { key: "OPENAI_API_KEY", spec: { from: { env: "OPENAI_API_KEY" } } },
    ]);
    expect(() => builder.addCodexHarness({ name: "invalid", apiKey: "secret" })).toThrow(
      /must be an environment reference/,
    );
    expect(() => builder.addCodexHarness({ name: "invalid-port", port: 70000 })).toThrow(
      /integer between 1 and 65535/,
    );
    expect(() => builder.addCodexHarness({ name: "coder" })).toThrow(
      /Duplicate Codex harness name/,
    );

    const custom = makeBuilder();
    custom.builder.addCodexHarness({
      name: "custom",
      port: 4000,
      model: "gpt-5.6",
      mcpServers: { custom: { url: "http://localhost:5000" } },
    });
    expect(custom.plan.runtime.codexHarnesses[0]).toMatchObject({
      port: 4000,
      model: "gpt-5.6",
      mcpServers: { custom: { url: "http://localhost:5000" } },
    });
  });

  it("normalizes Claude without creating a daemon process", () => {
    const { builder, environments, languages, packages, plan, processes, snippets } = makeBuilder();
    const tools = ["Bash", "Read"];
    builder.addClaudeHarness({
      name: "assistant",
      model: "claude-sonnet",
      apiKey: { env: "ANTHROPIC_API_KEY" },
      tools,
      permissions: "acceptEdits",
      telemetry: { enabled: false, capturePayloads: true },
    });
    tools.push("Edit");

    expect(plan.runtime.claudeHarnesses[0]).toMatchObject({
      model: "claude-sonnet",
      tools: ["Bash", "Read"],
      permissions: "acceptEdits",
      telemetry: {
        enabled: false,
        path: "/workspace/.biodome-build/logs/claude-assistant-events.jsonl",
        capturePayloads: true,
      },
    });
    expect(languages).toEqual([{ name: "node", options: { version: "20" } }]);
    expect(packages).toEqual(["git"]);
    expect(snippets).toEqual(["RUN npm install -g @anthropic-ai/claude-code"]);
    expect(environments).toEqual([
      { key: "ANTHROPIC_API_KEY", spec: { from: { env: "ANTHROPIC_API_KEY" } } },
    ]);
    expect(processes).toEqual([]);
    expect(() => builder.addClaudeHarness({ name: "assistant" })).toThrow(
      /Duplicate Claude harness name/,
    );
    expect(() => builder.addClaudeHarness({ name: "literal", apiKey: "secret" })).toThrow(
      /must be an environment reference/,
    );
  });

  it("preserves family-local names and propagates injected capability failures after recording", () => {
    const processFailure = new Error("duplicate process");
    const { builder, plan } = makeBuilder({
      addProcess: () => {
        throw processFailure;
      },
    });

    expect(() => builder.addOpencodeHarness({ name: "shared" })).toThrow(processFailure);
    expect(plan.runtime.agentHarnesses).toHaveLength(1);
    builder.addPiHarness({ name: "shared" });
    builder.addClaudeHarness({ name: "shared" });

    expect(plan.runtime.piHarnesses).toHaveLength(1);
    expect(plan.runtime.claudeHarnesses).toHaveLength(1);

    const environmentFailure = new Error("duplicate environment");
    const failedEnvironment = makeBuilder({
      addEnv: () => {
        throw environmentFailure;
      },
    });
    expect(() =>
      failedEnvironment.builder.addPiHarness({ name: "env", apiKey: { env: "API_KEY" } }),
    ).toThrow(environmentFailure);
    expect(failedEnvironment.plan.runtime.piHarnesses).toHaveLength(1);
  });
});
