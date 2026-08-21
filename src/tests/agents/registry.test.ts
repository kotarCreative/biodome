import { describe, expect, it } from "vitest";
import { agentTaskCommand, builtInAgentAdapters, resolveAgent } from "../../agents/index.js";
import { createPlan, type Plan } from "../../core/plan.js";
import { runtimeLayout } from "../../runtime/layout.js";

function planFor(type: "pi" | "claude" | "codex" | "opencode"): Plan {
  const plan = createPlan("agents-test");
  plan.deployment = {
    target: { name: "local", driver: "docker-compose", options: {} },
    deploymentId: "test-deployment",
  };

  if (type === "pi") {
    plan.runtime.piHarnesses.push({
      name: "agent",
      type,
      telemetry: { enabled: false, path: "" },
      config: {},
    });
  } else if (type === "claude") {
    plan.runtime.claudeHarnesses.push({
      name: "agent",
      type,
      telemetry: { enabled: false, path: "" },
      config: {},
    });
  } else if (type === "codex") {
    plan.runtime.codexHarnesses.push({
      name: "agent",
      type,
      port: 3003,
      mcpServers: {},
      telemetry: { enabled: false, path: "" },
      config: {},
    });
  } else {
    plan.runtime.agentHarnesses.push({
      name: "agent",
      type,
      port: 3002,
      mcpServers: {},
      telemetry: { enabled: false, path: "" },
      config: {},
    });
  }
  return plan;
}

describe("agent adapters", () => {
  it("registers every built-in agent harness", () => {
    expect(builtInAgentAdapters.map((adapter) => adapter.id)).toEqual([
      "pi",
      "claude",
      "codex",
      "opencode",
    ]);
  });

  it.each([
    ["pi", "pi-homes"],
    ["claude", "claude-homes"],
    ["codex", "codex-homes"],
    ["opencode", "opencode-homes"],
  ] as const)("resolves %s to its task command", (type, home) => {
    const plan = planFor(type);
    const resolved = resolveAgent(plan, "agent");

    expect(resolved.adapter.id).toBe(type);
    expect(agentTaskCommand(plan, "agent", "Review the code")).toEqual([
      `/workspace/.biodome-build/targets/local/${home}/agent/task`,
      "Review the code",
    ]);
  });

  it("fails clearly when no harness has the requested name", () => {
    expect(() => resolveAgent(planFor("pi"), "missing")).toThrow(/not found in plan/);
  });

  it("fails clearly for a configured harness with no adapter", () => {
    const plan = planFor("opencode");
    plan.runtime.agentHarnesses[0].type = "custom-agent";
    expect(() => resolveAgent(plan, "agent")).toThrow(/No agent adapter is registered/);
  });

  it.each([
    ["pi", "pi-homes"],
    ["claude", "claude-homes"],
    ["codex", "codex-homes"],
    ["opencode", "opencode-homes"],
  ] as const)("emits %s commands byte-equivalent to the pre-factory adapter", (type, home) => {
    const { adapter, harness } = resolveAgent(planFor(type), "agent");
    const layout = runtimeLayout("", "local").container;
    const inputs = [
      { name: "agent", prompt: "Review the code" },
      { name: "worker-1", prompt: "" },
      { name: "pair review", prompt: "Fix the flaky test\nthen rerun" },
    ] as const;

    for (const input of inputs) {
      expect(
        adapter.command({
          harness: { ...harness, name: input.name },
          prompt: input.prompt,
          layout,
        }),
      ).toEqual([
        `/workspace/.biodome-build/targets/local/${home}/${input.name}/task`,
        input.prompt,
      ]);
    }
  });

  it("fails loudly instead of falling back when the plan has no deployment target", () => {
    const plan = planFor("pi");
    plan.deployment = undefined;
    expect(() => agentTaskCommand(plan, "agent", "Review the code")).toThrow(
      /no deployment target/,
    );
  });
});
