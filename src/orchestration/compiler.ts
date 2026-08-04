import { createHash } from "node:crypto";
import type { Plan } from "../core/plan.js";
import type { RuntimeDriver } from "../runtime/driver.js";
import { EXECUTION_PLAN_VERSION, type ExecutionPlan } from "./execution-plan.js";
import type { ProviderProfile } from "./compatibility.js";

/** Compile the legacy plan into the portable contract used by orchestration. */
export function compileExecutionPlan(plan: Plan): ExecutionPlan {
  const deployment = plan.deployment;
  if (!deployment?.task) throw new Error("Cannot compile an execution plan without a task");

  const task = deployment.task;
  const capabilities: ExecutionPlan["task"]["capabilities"] = [
    { capability: "exec.command", level: "required", reason: "agent tasks execute a command" },
  ];
  if (task.artifacts.length > 0) {
    capabilities.push({
      capability: "artifact.collect",
      level: "required",
      reason: "the task declares output artifacts",
    });
  }
  for (const requirement of task.capabilities ?? []) {
    if (!capabilities.some((item) => item.capability === requirement.capability)) {
      capabilities.push({
        capability: requirement.capability,
        level: requirement.level ?? "required",
        reason: requirement.reason,
      });
    }
  }

  return {
    version: EXECUTION_PLAN_VERSION,
    project: plan.project,
    target: {
      name: deployment.target.name,
      provider: deployment.target.driver,
      options: deployment.target.options,
    },
    task: {
      name: task.name,
      agent: { harness: task.harness },
      prompt: task.prompt,
      timeout: task.timeout,
      cleanup: task.cleanup,
      requiredServices:
        task.requiredServices ?? plan.runtime.services.map((service) => service.name),
      requiredProcesses:
        task.requiredProcesses ??
        plan.runtime.processes
          .filter((process) => process.mode === "daemon")
          .map((process) => process.name),
      capabilities,
      resources: task.resources,
      network: {
        mode: task.network?.mode ?? "egress",
        allow: task.network?.allow ?? [],
      },
      secrets: [],
      workspace:
        task.workspace ??
        ({ strategy: deployment.target.driver === "docker-sandbox" ? "clone" : "bind" } as const),
      artifacts: task.artifacts.map((path) => ({ path, required: false })),
      validationCommands: task.validationCommands ?? [],
    },
    services: plan.runtime.services.map((service) => ({
      name: service.name,
      kind: service.type,
      image: service.image,
      persistence: service.volumes.length > 0 ? "workspace" : "task",
    })),
    processes: plan.runtime.processes.map((process) => ({
      name: process.name,
      command: process.command,
      mode: process.mode,
      workingDirectory: process.workingDir,
    })),
  };
}

export function providerProfile(driver: RuntimeDriver): ProviderProfile {
  return { id: driver.id, capabilities: driver.capabilities };
}

export function executionPlanDigest(plan: ExecutionPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
