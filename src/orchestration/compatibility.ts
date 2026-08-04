import type { Capabilities, Capability } from "../core/capabilities.js";
import type { CapabilityRequirement, ExecutionPlan } from "./execution-plan.js";

export interface ProviderProfile {
  id: string;
  capabilities: Capabilities;
  maxResources?: { cpu?: number; memoryMiB?: number; diskMiB?: number };
}

export interface CompatibilityIssue {
  kind: "capability" | "resource";
  level: "required" | "preferred";
  subject: string;
  reason?: string;
}

export interface CompatibilityReport {
  provider: string;
  compatible: boolean;
  missing: CompatibilityIssue[];
  warnings: CompatibilityIssue[];
  supported: Capability[];
}

function capabilityIssue(requirement: CapabilityRequirement): CompatibilityIssue {
  return {
    kind: "capability",
    level: requirement.level,
    subject: requirement.capability,
    reason: requirement.reason,
  };
}

function resourceIssues(
  requested: ExecutionPlan["task"]["resources"],
  available: ProviderProfile["maxResources"],
): CompatibilityIssue[] {
  if (!requested || !available) return [];
  const entries: Array<[keyof NonNullable<typeof requested>, string]> = [
    ["cpu", "CPU"],
    ["memoryMiB", "memory (MiB)"],
    ["diskMiB", "disk (MiB)"],
  ];
  return entries.flatMap(([key, label]) => {
    const value = requested[key];
    const maximum = available[key];
    if (value === undefined || maximum === undefined || value <= maximum) return [];
    return [
      {
        kind: "resource" as const,
        level: "required" as const,
        subject: label,
        reason: `requested ${value}, provider maximum ${maximum}`,
      },
    ];
  });
}

/**
 * Compare portable task requirements with a provider before resources are
 * created. Preferred requirements become warnings; required ones block a run.
 */
export function validateCompatibility(
  plan: ExecutionPlan,
  provider: ProviderProfile,
): CompatibilityReport {
  const unsupported = plan.task.capabilities
    .filter((requirement) => !provider.capabilities.has(requirement.capability))
    .map(capabilityIssue);
  const resource = resourceIssues(plan.task.resources, provider.maxResources);
  const issues = [...unsupported, ...resource];
  return {
    provider: provider.id,
    compatible: !issues.some((issue) => issue.level === "required"),
    missing: issues.filter((issue) => issue.level === "required"),
    warnings: issues.filter((issue) => issue.level === "preferred"),
    supported: [...provider.capabilities],
  };
}
