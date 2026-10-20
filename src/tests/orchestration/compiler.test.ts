import { describe, expect, it } from "vitest";
import { createPlan, type Plan } from "../../core/plan.js";
import {
  compileExecutionPlan,
  defaultWorkspaceStrategy,
  executionPlanDigest,
} from "../../orchestration/compiler.js";

function legacyPlan(artifacts = ["review.md"]): Plan {
  const plan = createPlan("demo");
  plan.runtime.services.push({
    name: "postgres",
    type: "postgres",
    environment: {},
    ports: [],
  });
  plan.runtime.processes.push({
    name: "api",
    command: ["npm", "run", "dev"],
    ports: [],
    environment: {},
    mode: "daemon",
    startOn: "start.post",
    workingDir: "/workspace",
  });
  plan.deployment = {
    target: { name: "secure", driver: "docker-sandbox", options: { workspaceMode: "clone" } },
    deploymentId: "deployment-1",
    task: {
      name: "review",
      command: ["npm", "test"],
      intent: "Review the change",
      input: {},
      artifacts,
      timeout: "30m",
      cleanup: "always",
    },
  };
  return plan;
}

describe("compileExecutionPlan", () => {
  it("turns a legacy task plan into a provider-neutral contract", () => {
    const executionPlan = compileExecutionPlan(legacyPlan());

    expect(executionPlan.target).toEqual({
      name: "secure",
      provider: "docker-sandbox",
      options: { workspaceMode: "clone" },
    });
    expect(executionPlan.task).toMatchObject({
      name: "review",
      command: ["npm", "test"],
      workspace: { strategy: "clone" },
      requiredServices: ["postgres"],
      requiredProcesses: ["api"],
      artifacts: [{ path: "review.md", required: true }],
    });
    expect(executionPlan.task.capabilities).toEqual([
      { capability: "exec.inplace", level: "required", reason: "actions execute a command" },
      {
        capability: "artifact.collect",
        level: "required",
        reason: "the task declares output artifacts",
      },
    ]);
    expect(executionPlan.services).toEqual([
      {
        name: "postgres",
        kind: "postgres",
      },
    ]);
    expect(executionPlan.processes).toEqual([
      {
        name: "api",
        command: ["npm", "run", "dev"],
        mode: "daemon",
        workingDirectory: "/workspace",
      },
    ]);
  });

  it("only requires artifact collection for tasks that declare artifacts", () => {
    expect(
      compileExecutionPlan(legacyPlan([])).task.capabilities.map((item) => item.capability),
    ).toEqual(["exec.inplace"]);
  });

  it("requires a selected task and produces stable content digests", () => {
    const plan = createPlan("demo");
    expect(() => compileExecutionPlan(plan)).toThrow("without a task");
    const first = compileExecutionPlan(legacyPlan());
    expect(executionPlanDigest(first)).toBe(executionPlanDigest(first));
    expect(executionPlanDigest(first)).not.toBe(
      executionPlanDigest(compileExecutionPlan(legacyPlan([]))),
    );
  });
});

describe("defaultWorkspaceStrategy", () => {
  it("never silently selects bind for remote or job-oriented providers", () => {
    expect(defaultWorkspaceStrategy("aws-ecs")).toEqual({ strategy: "upload" });
    expect(defaultWorkspaceStrategy("docker-sandbox")).toEqual({ strategy: "clone" });
  });

  it("keeps the local bind default for Docker Compose", () => {
    expect(defaultWorkspaceStrategy("docker-compose")).toEqual({ strategy: "bind" });
  });

  it("refuses to guess a workspace strategy for unregistered drivers", () => {
    expect(() => defaultWorkspaceStrategy("unknown-provider")).toThrow(
      /Cannot default a workspace strategy/,
    );
  });

  it("compiles tasks without an explicit workspace onto the driver-safe default", () => {
    const remote = legacyPlan();
    remote.deployment!.target = { name: "remote", driver: "aws-ecs", options: {} };
    expect(compileExecutionPlan(remote).task.workspace).toEqual({ strategy: "upload" });
  });
});
