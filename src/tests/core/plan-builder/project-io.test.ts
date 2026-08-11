import { describe, expect, it, vi } from "vitest";
import { PlanBuilder } from "../../../core/plan-builder/plan-builder.js";
import type { ProjectIO } from "../../../core/plan-builder/project-io.js";

function fakeProjectIO(files: Record<string, string>): ProjectIO {
  return {
    fileExists: (path) => path in files,
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`Missing ${path}`);
      return content;
    },
    readJSON(path) {
      return JSON.parse(this.readFile(path));
    },
    exec: () => ({ stdout: "branch=main\n", stderr: "", exitCode: 0 }),
  };
}

describe("PlanBuilder", () => {
  it("uses injected project IO for manifest detection and feature reads", () => {
    const builder = new PlanBuilder(
      "/unused",
      "test",
      false,
      fakeProjectIO({ "package.json": '{"name":"test"}' }),
    );

    builder.context.addLanguage("node", { version: "20" });
    expect(builder.context.fileExists("package.json")).toBe(true);
    expect(builder.context.readJSON("package.json")).toEqual({ name: "test" });
    builder.finalize();

    expect(builder.getPlan().build.dependencyFiles).toEqual(["package.json"]);
  });

  it("keeps dry-run command execution side-effect free", () => {
    let executions = 0;
    const io = fakeProjectIO({});
    io.exec = () => {
      executions += 1;
      return { stdout: "unexpected", stderr: "", exitCode: 1 };
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const builder = new PlanBuilder("/unused", "test", true, io);

    expect(builder.context.exec("git branch --show-current")).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(executions).toBe(0);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("composes endpoint, MCP provider, and LLM provider contributions", () => {
    const builder = new PlanBuilder("/unused", "test", false, fakeProjectIO({}));

    builder.context.addEndpoint({ name: "api", port: 8000 });
    builder.context.addMcpProvider({
      name: "jira",
      type: "jira",
      mcpUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
      credentials: { token: { env: "JIRA_TOKEN" } },
    });
    builder.context.addLlmProvider({
      name: "lmstudio",
      options: { apiKey: { env: "LMSTUDIO_API_KEY" } },
    });
    builder.context.addProcess({ name: "web", command: ["node", "server.js"], port: 3000 });
    builder.context.addS3Volume({
      name: "assets",
      bucket: "test-assets",
      target: "/workspace/assets",
      proxy: true,
      credentials: { accessKeyId: { env: "AWS_ACCESS_KEY_ID" } },
    });
    builder.context.addOpencodeHarness({ name: "open" });
    builder.context.addPiHarness({ name: "pi", apiKey: { env: "PI_API_KEY" } });
    builder.context.addCodexHarness({ name: "codex", apiKey: { env: "CODEX_API_KEY" } });
    builder.context.addClaudeHarness({ name: "claude", apiKey: { env: "CLAUDE_API_KEY" } });
    builder.configureMcp(3001);
    builder.finalize();

    const plan = builder.getPlan();
    const mcp = plan.runtime.processes.find((process) => process.name === "biodome-mcp");
    expect(plan.runtime.endpoints).toHaveLength(1);
    expect(plan.runtime.providers).toHaveLength(1);
    expect(plan.runtime.llmProviders).toHaveLength(1);
    expect(plan.runtime.volumes).toHaveLength(1);
    expect(plan.runtime.processes).toHaveLength(4);
    expect(plan.runtime.agentHarnesses).toHaveLength(1);
    expect(plan.runtime.piHarnesses).toHaveLength(1);
    expect(plan.runtime.codexHarnesses).toHaveLength(1);
    expect(plan.runtime.claudeHarnesses).toHaveLength(1);
    expect(mcp).toMatchObject({
      mergeEnv: false,
      environment: {
        AWS_ACCESS_KEY_ID: "${AWS_ACCESS_KEY_ID}",
        JIRA_TOKEN: "${JIRA_TOKEN}",
      },
    });
    expect(plan.runtime.environment.JIRA_TOKEN).toBeUndefined();
    expect(plan.runtime.envVars).toContainEqual({
      key: "LMSTUDIO_API_KEY",
      scope: "runtime",
      from: { env: "LMSTUDIO_API_KEY" },
      required: undefined,
      default: undefined,
    });
  });

  it("exposes the plan only after exactly one successful finalization", () => {
    const builder = new PlanBuilder("/unused", "test", false, fakeProjectIO({}));
    builder.context.addLanguage("node", { version: "20" });

    expect("plan" in builder.context).toBe(false);
    expect(() => builder.getPlan()).toThrow("Plan is not available before finalization");

    builder.finalize();
    const plan = builder.getPlan();
    const snapshot = structuredClone(plan);

    expect(() => builder.finalize()).toThrow("PlanBuilder is already finalized");
    expect(plan).toEqual(snapshot);
  });
});
