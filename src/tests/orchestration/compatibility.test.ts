import { describe, expect, it } from "vitest";
import { capabilitiesOf } from "../../core/capabilities.js";
import type { ExecutionPlan } from "../../orchestration/execution-plan.js";
import { validateCompatibility } from "../../orchestration/compatibility.js";
import { providerProfile } from "../../orchestration/compiler.js";
import { dockerComposeDriver } from "../../runtime/docker-compose.js";
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

  it("rejects local requirements that Docker drivers do not enforce", () => {
    const executionPlan = plan([]);
    executionPlan.task.workspace = { strategy: "upload" };
    executionPlan.task.resources = { cpu: 1 };
    executionPlan.task.network.allow = ["api.example.test:443"];
    executionPlan.services.push({
      name: "redis",
      kind: "redis",
      runtime: "process",
      persistence: "task",
    });

    const report = validateCompatibility(executionPlan, providerProfile(dockerComposeDriver));

    expect(report.compatible).toBe(false);
    expect(report.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspace", subject: 'workspace strategy "upload"' }),
        expect.objectContaining({ kind: "resource", subject: "cpu" }),
        expect.objectContaining({ kind: "network", subject: "network allowlist" }),
        expect.objectContaining({ kind: "service", subject: 'service "redis"' }),
      ]),
    );
  });

  it("accepts the generated PostgreSQL process service locally", () => {
    const executionPlan = plan([]);
    executionPlan.task.network.allow = [];
    executionPlan.services.push({
      name: "postgres",
      kind: "postgres",
      runtime: "process",
      persistence: "task",
    });

    expect(
      validateCompatibility(executionPlan, providerProfile(dockerSandboxDriver)).compatible,
    ).toBe(true);
  });
});
