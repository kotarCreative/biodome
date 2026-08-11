import { describe, expect, it } from "vitest";
import { createPlan, type Plan } from "../../core/plan.js";
import { compileExecutionPlan, executionPlanDigest } from "../../orchestration/compiler.js";

function legacyPlan(artifacts = ["review.md"]): Plan {
  const plan = createPlan("demo");
  plan.runtime.services.push({
    name: "postgres",
    type: "postgres",
    image: "postgres:17",
    containerName: "postgres",
    environment: {},
    ports: [],
    volumes: [{ host: "pg-data", container: "/var/lib/postgresql/data" }],
    networks: [],
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
      harness: "codex",
      prompt: "Review the change",
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
      agent: { harness: "codex" },
      workspace: { strategy: "clone" },
      requiredServices: ["postgres"],
      requiredProcesses: ["api"],
      artifacts: [{ path: "review.md", required: false }],
    });
    expect(executionPlan.task.capabilities).toEqual([
      { capability: "exec.inplace", level: "required", reason: "agent tasks execute a command" },
      {
        capability: "artifact.collect",
        level: "required",
        reason: "the task declares output artifacts",
      },
    ]);
    expect(executionPlan.services).toEqual([
      { name: "postgres", kind: "postgres", image: "postgres:17", persistence: "workspace" },
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
