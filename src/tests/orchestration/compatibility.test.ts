import { describe, expect, it } from "vitest";
import { capabilitiesOf } from "../../core/capabilities.js";
import type { ExecutionPlan } from "../../orchestration/execution-plan.js";
import { validateCompatibility } from "../../orchestration/compatibility.js";
import { dockerSandboxDriver } from "../../runtime/docker-sandbox.js";

function plan(requirements: ExecutionPlan["task"]["capabilities"]): ExecutionPlan {
  return {
    version: 1,
    project: "demo",
    target: { name: "local", provider: "example", options: {} },
    task: {
      name: "review",
      agent: { harness: "codex" },
      prompt: "Review this repository",
      timeout: "30m",
      cleanup: "always",
      requiredServices: [],
      requiredProcesses: [],
      capabilities: requirements,
      network: { mode: "egress", allow: ["api.example.test:443"] },
      secrets: [],
      workspace: { strategy: "clone", repository: "https://example.test/demo.git" },
      artifacts: [],
      validationCommands: [],
    },
    services: [],
    processes: [],
  };
}

describe("validateCompatibility", () => {
  it("blocks missing required capabilities before a provider is used", () => {
    const report = validateCompatibility(
      plan([{ capability: "network.policy", level: "required", reason: "allowlist API access" }]),
      {
        id: "compose",
        capabilities: capabilitiesOf("exec.inplace"),
      },
    );

    expect(report.compatible).toBe(false);
    expect(report.missing).toEqual([
      {
        kind: "capability",
        level: "required",
        subject: "network.policy",
        reason: "allowlist API access",
      },
    ]);
  });

  it("rejects required network policy for Docker Sandbox before provider side effects", () => {
    const report = validateCompatibility(
      plan([{ capability: "network.policy", level: "required", reason: "isolated task" }]),
      dockerSandboxDriver,
    );

    expect(report.compatible).toBe(false);
    expect(report.missing[0]).toMatchObject({ subject: "network.policy" });
  });

  it("reports missing preferred capabilities as warnings", () => {
    const report = validateCompatibility(
      plan([{ capability: "snapshot.create", level: "preferred" }]),
      {
        id: "ecs",
        capabilities: capabilitiesOf("exec.inplace"),
      },
    );

    expect(report.compatible).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.missing).toEqual([]);
  });

  it("validates declared task resources when a provider publishes limits", () => {
    const executionPlan = plan([]);
    executionPlan.task.resources = { cpu: 4, memoryMiB: 8192 };
    const report = validateCompatibility(executionPlan, {
      id: "small",
      capabilities: capabilitiesOf(),
      maxResources: { cpu: 2, memoryMiB: 16384 },
    });

    expect(report.compatible).toBe(false);
    expect(report.missing).toEqual([
      {
        kind: "resource",
        level: "required",
        subject: "CPU",
        reason: "requested 4, provider maximum 2",
      },
    ]);
  });
});
