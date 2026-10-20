import { describe, expect, it } from "vitest";
import { PlanBuilder } from "../../../core/plan-builder/plan-builder.js";
import { generateCompose } from "../../../docker/generators/compose.js";
import { MCP_RUNTIME_FILES, renderCommonArtifacts } from "../../../runtime/artifacts.js";
import { runtimeLayout } from "../../../runtime/layout.js";

describe("complete environment artifacts", () => {
  it("builds services, hooks, health checks, and external access without embedded agents", () => {
    const builder = new PlanBuilder("/unused", "complete", true);
    builder.context.addLanguage("node", { version: "22" });
    builder.context.addService("postgres", { databases: [{ name: "app" }] });
    builder.context.addProcess({
      name: "web",
      command: ["npm", "start"],
      port: 3000,
      healthCheck: { type: "http", url: "http://localhost:3000/health" },
    });
    builder.context.addHook({
      name: "migrate",
      command: ["npm", "run", "migrate"],
      startOn: "start.pre",
    });
    builder.configureMcp(3001, { token: { env: "MCP_TOKEN" } });
    builder.finalize();
    const plan = builder.getPlan();
    plan.deployment = {
      target: { name: "local", driver: "docker-compose", options: {} },
      deploymentId: "complete-local",
    };
    const files = renderCommonArtifacts(plan, runtimeLayout("/project", "local"));
    const paths = files.map((file) => file.relativePath);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(paths).toContain(".biodome-build/targets/local/startup.sh");
    expect(paths).toContain(".biodome-build/targets/local/healthchecks/web.sh");
    expect(paths.some((path) => /homes|telemetry\/writer/.test(path))).toBe(false);
    const dockerfile =
      files.find((file) => file.relativePath.endsWith("/Dockerfile"))?.content ?? "";
    expect(dockerfile).toContain("node:22");
    expect(dockerfile).not.toMatch(/opencode-ai|pi-coding-agent|@openai\/codex|claude-code/);
    const startup = files.find((file) => file.relativePath.endsWith("/startup.sh"));
    expect(startup?.mode).toBe(0o755);
    expect(startup?.content).toContain("migrate");
    for (const runtimeFile of MCP_RUNTIME_FILES) {
      expect(paths).toContain(`.biodome-build/targets/local/${runtimeFile}`);
    }
    const compose = generateCompose(plan);
    expect(compose).toContain("127.0.0.1:3000:3000");
    expect(compose).not.toContain("privileged: true");
  });
});
