import type { Capabilities, Capability } from "../core/capabilities.js";
import type { Plan } from "../core/plan.js";
import type {
  ArtifactTransport,
  CapabilityRequirement,
  ExecutionPlan,
  SecretExposure,
} from "./execution-plan.js";

export type WorkspaceStrategy = "bind" | "clone" | "upload" | "snapshot";
export type NetworkMode = "isolated" | "egress" | "unrestricted";

export interface ResourceBounds {
  cpu?: number;
  memoryMiB?: number;
  diskMiB?: number;
}

export interface ProviderProfile {
  id: string;
  capabilities: Capabilities;
  maxResources?: ResourceBounds;
  supportsTaskResources?: boolean;
  workspaceStrategies?: readonly WorkspaceStrategy[];
  serviceKinds?: readonly string[];
  processServiceKinds?: readonly string[];
  networkModes?: readonly NetworkMode[];
  networkAllowlist?: boolean;
  secretExposures?: readonly SecretExposure[];
  artifactTransports?: readonly ArtifactTransport[];
}

export type CompatibilityIssueKind =
  | "capability"
  | "resource"
  | "workspace"
  | "service"
  | "network"
  | "secret"
  | "artifact";

export interface CompatibilityIssue {
  kind: CompatibilityIssueKind;
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
  requested: ResourceBounds | undefined,
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

function taskResourceIssues(
  requested: ResourceBounds | undefined,
  provider: ProviderProfile,
): CompatibilityIssue[] {
  if (!requested) return [];
  if (provider.supportsTaskResources === false) {
    return Object.entries(requested)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => ({
        kind: "resource" as const,
        level: "required" as const,
        subject: key,
        reason: "provider does not enforce portable task resource requirements",
      }));
  }
  return resourceIssues(requested, provider.maxResources);
}

function workspaceIssues(
  workspace: ExecutionPlan["task"]["workspace"],
  provider: ProviderProfile,
): CompatibilityIssue[] {
  if (!provider.workspaceStrategies || !workspace) return [];
  if (provider.workspaceStrategies.includes(workspace.strategy)) return [];
  return [
    {
      kind: "workspace",
      level: "required",
      subject: `workspace strategy "${workspace.strategy}"`,
      reason: `provider supports ${provider.workspaceStrategies.join(", ")}`,
    },
  ];
}

function serviceIssues(
  services: ExecutionPlan["services"],
  provider: ProviderProfile,
): CompatibilityIssue[] {
  return services.flatMap((service) => {
    const supportedKinds =
      service.runtime === "process" ? provider.processServiceKinds : provider.serviceKinds;
    // Container services are passed directly to Docker Compose and therefore
    // have no finite provider-owned kind list. Process services do.
    if (!supportedKinds && service.runtime === "container") return [];
    // A provider that does not publish a process-service list retains the
    // historical default of running them in the dev image.
    if (!supportedKinds && service.runtime === "process") return [];
    if (supportedKinds?.includes(service.kind)) return [];
    return [
      {
        kind: "service" as const,
        level: "required" as const,
        subject: `service "${service.name}"`,
        reason: `kind "${service.kind}" is not supported by this provider`,
      },
    ];
  });
}

function networkIssues(
  network: ExecutionPlan["task"]["network"],
  provider: ProviderProfile,
): CompatibilityIssue[] {
  if (!network) return [];
  const issues: CompatibilityIssue[] = [];
  if (provider.networkModes && !provider.networkModes.includes(network.mode)) {
    issues.push({
      kind: "network",
      level: "required",
      subject: `network mode "${network.mode}"`,
      reason: `provider supports ${provider.networkModes.join(", ")}`,
    });
  }
  if (network.allow.length > 0 && provider.networkAllowlist === false) {
    issues.push({
      kind: "network",
      level: "required",
      subject: "network allowlist",
      reason: "provider does not enforce destination allowlists",
    });
  }
  return issues;
}

function secretIssues(
  secrets: ExecutionPlan["task"]["secrets"],
  provider: ProviderProfile,
): CompatibilityIssue[] {
  if (!provider.secretExposures) return [];
  return secrets.flatMap((secret) => {
    if (provider.secretExposures!.includes(secret.exposure)) return [];
    const issue: CompatibilityIssue = {
      kind: "secret",
      level: secret.required ? "required" : "preferred",
      subject: `secret "${secret.name}"`,
      reason: `exposure "${secret.exposure}" is not supported by this provider`,
    };
    return [issue];
  });
}

function artifactIssues(
  artifacts: ExecutionPlan["task"]["artifacts"],
  provider: ProviderProfile,
): CompatibilityIssue[] {
  if (!provider.artifactTransports) return [];
  return artifacts.flatMap((artifact) => {
    if (!artifact.transport) return [];
    if (provider.artifactTransports!.includes(artifact.transport)) return [];
    const issue: CompatibilityIssue = {
      kind: "artifact",
      level: artifact.required ? "required" : "preferred",
      subject: `artifact "${artifact.path}"`,
      reason: `transport "${artifact.transport}" is not supported by this provider`,
    };
    return [issue];
  });
}

function report(provider: ProviderProfile, issues: CompatibilityIssue[]): CompatibilityReport {
  return {
    provider: provider.id,
    compatible: !issues.some((issue) => issue.level === "required"),
    missing: issues.filter((issue) => issue.level === "required"),
    warnings: issues.filter((issue) => issue.level === "preferred"),
    supported: [...provider.capabilities],
  };
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
  const issues = [
    ...unsupported,
    ...taskResourceIssues(plan.task.resources, provider),
    ...workspaceIssues(plan.task.workspace, provider),
    ...serviceIssues(plan.services, provider),
    ...networkIssues(plan.task.network, provider),
    ...secretIssues(plan.task.secrets, provider),
    ...artifactIssues(plan.task.artifacts, provider),
  ];
  return report(provider, issues);
}

function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isWorkspaceStrategy(value: string): value is WorkspaceStrategy {
  return ["bind", "clone", "upload", "snapshot"].includes(value);
}

function isNetworkMode(value: string): value is NetworkMode {
  return ["isolated", "egress", "unrestricted"].includes(value);
}

/**
 * Target-level preflight: check the target's declared plan requirements
 * against the provider profile before any rendering, building, or provider
 * calls. Task-scoped requirements (capabilities, secrets, network) are not
 * checkable without a task and are therefore skipped.
 */
export function preflightTargetCompatibility(
  plan: Plan,
  provider: ProviderProfile,
): CompatibilityReport {
  const target = plan.deployment?.target;
  const options = target?.options ?? {};
  const issues: CompatibilityIssue[] = [];

  for (const service of plan.runtime.services) {
    const runtime = service.runtime ?? "container";
    const supportedKinds =
      runtime === "process" ? provider.processServiceKinds : provider.serviceKinds;
    if (!supportedKinds && runtime === "container") continue;
    if (supportedKinds?.includes(service.type)) continue;
    // A provider that does not publish a process-service list retains the
    // historical default of running them in the dev image.
    if (!supportedKinds && runtime === "process") continue;
    issues.push({
      kind: "service",
      level: "required",
      subject: `service "${service.name}"`,
      reason: `kind "${service.type}" is not supported by this provider`,
    });
  }

  const strategy = optionString(options, "workspaceMode", "strategy");
  if (
    strategy &&
    provider.workspaceStrategies &&
    (!isWorkspaceStrategy(strategy) || !provider.workspaceStrategies.includes(strategy))
  ) {
    issues.push({
      kind: "workspace",
      level: "required",
      subject: `workspace strategy "${strategy}"`,
      reason: `provider supports ${provider.workspaceStrategies.join(", ")}`,
    });
  }

  const mode = optionString(options, "networkMode");
  if (
    mode &&
    provider.networkModes &&
    (!isNetworkMode(mode) || !provider.networkModes.includes(mode))
  ) {
    issues.push({
      kind: "network",
      level: "required",
      subject: `network mode "${mode}"`,
      reason: `provider supports ${provider.networkModes.join(", ")}`,
    });
  }

  const cpu = typeof options.cpu === "number" ? options.cpu : undefined;
  const memoryMiB = typeof options.memoryMiB === "number" ? options.memoryMiB : undefined;
  const requested = { cpu, memoryMiB };
  if (provider.maxResources) {
    issues.push(...resourceIssues(requested, provider.maxResources));
  }

  return report(provider, issues);
}
