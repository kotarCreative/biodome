/**
 * Provider-neutral description of an agent execution.  This is deliberately
 * free of Docker, ECS, filesystem-layout, and generated-script details: a
 * provider compiles this intent into its own deployment representation.
 */
import { Schema } from "effect";
import type { Capability } from "../core/capabilities.js";

export const EXECUTION_PLAN_VERSION = 1;

export type RequirementLevel = "required" | "preferred";

export interface CapabilityRequirement {
  capability: Capability;
  level: RequirementLevel;
  reason?: string;
}

export interface ResourceRequirements {
  cpu?: number;
  memoryMiB?: number;
  diskMiB?: number;
}

export interface NetworkRequirement {
  mode: "isolated" | "egress" | "unrestricted";
  allow: string[];
}

export type SecretExposure = "request-proxy" | "environment" | "file" | "agent-forwarding";

export interface SecretRequirement {
  name: string;
  purpose: string;
  exposure: SecretExposure;
  destinations: string[];
  required: boolean;
}

export interface WorkspaceRequirement {
  strategy: "bind" | "clone" | "upload" | "snapshot";
  repository?: string;
  ref?: string;
  path?: string;
}

export interface ArtifactRequirement {
  path: string;
  required: boolean;
}

export interface ServiceRequirement {
  name: string;
  kind: string;
  version?: string;
  image?: string;
  persistence: "task" | "workspace" | "external";
  endpoint?: string;
  resources?: ResourceRequirements;
}

export interface ProcessRequirement {
  name: string;
  command: string[];
  mode: "daemon" | "oneshot";
  workingDirectory?: string;
}

export interface AgentTaskRequirement {
  name: string;
  agent: { harness: string; model?: string };
  prompt: string;
  timeout: string;
  cleanup: "always" | "on-success" | "never";
  requiredServices: string[];
  requiredProcesses: string[];
  capabilities: CapabilityRequirement[];
  resources?: ResourceRequirements;
  network: NetworkRequirement;
  secrets: SecretRequirement[];
  workspace: WorkspaceRequirement;
  artifacts: ArtifactRequirement[];
  validationCommands: string[][];
}

/** The portable contract passed to a provider before it renders resources. */
export interface ExecutionPlan {
  version: typeof EXECUTION_PLAN_VERSION;
  project: string;
  target: { name: string; provider: string; options: Record<string, unknown> };
  task: AgentTaskRequirement;
  services: ServiceRequirement[];
  processes: ProcessRequirement[];
}

const RequirementLevelSchema = Schema.Literals(["required", "preferred"]);
const ResourceRequirementsSchema = Schema.Struct({
  cpu: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  memoryMiB: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  diskMiB: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
const NetworkRequirementSchema = Schema.Struct({
  mode: Schema.Literals(["isolated", "egress", "unrestricted"]),
  allow: Schema.Array(Schema.String),
});
const SecretRequirementSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  purpose: Schema.String.check(Schema.isMinLength(1)),
  exposure: Schema.Literals(["request-proxy", "environment", "file", "agent-forwarding"]),
  destinations: Schema.Array(Schema.String),
  required: Schema.Boolean,
});
const WorkspaceRequirementSchema = Schema.Struct({
  strategy: Schema.Literals(["bind", "clone", "upload", "snapshot"]),
  repository: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});
const ArtifactRequirementSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  required: Schema.Boolean,
});
const CapabilityRequirementSchema = Schema.Struct({
  capability: Schema.String,
  level: RequirementLevelSchema,
  reason: Schema.optional(Schema.String),
});
const ServiceRequirementSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.String.check(Schema.isMinLength(1)),
  version: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  persistence: Schema.Literals(["task", "workspace", "external"]),
  endpoint: Schema.optional(Schema.String),
  resources: Schema.optional(ResourceRequirementsSchema),
});
const ProcessRequirementSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  mode: Schema.Literals(["daemon", "oneshot"]),
  workingDirectory: Schema.optional(Schema.String),
});
const AgentTaskRequirementSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  agent: Schema.Struct({
    harness: Schema.String.check(Schema.isMinLength(1)),
    model: Schema.optional(Schema.String),
  }),
  prompt: Schema.String.check(Schema.isMinLength(1)),
  timeout: Schema.String.check(Schema.isMinLength(1)),
  cleanup: Schema.Literals(["always", "on-success", "never"]),
  requiredServices: Schema.Array(Schema.String),
  requiredProcesses: Schema.Array(Schema.String),
  capabilities: Schema.Array(CapabilityRequirementSchema),
  resources: Schema.optional(ResourceRequirementsSchema),
  network: NetworkRequirementSchema,
  secrets: Schema.Array(SecretRequirementSchema),
  workspace: WorkspaceRequirementSchema,
  artifacts: Schema.Array(ArtifactRequirementSchema),
  validationCommands: Schema.Array(Schema.Array(Schema.String)),
});

export const ExecutionPlanSchema = Schema.Struct({
  version: Schema.Literal(EXECUTION_PLAN_VERSION),
  project: Schema.String.check(Schema.isMinLength(1)),
  target: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1)),
    provider: Schema.String.check(Schema.isMinLength(1)),
    options: Schema.Record(Schema.String, Schema.Unknown),
  }),
  task: AgentTaskRequirementSchema,
  services: Schema.Array(ServiceRequirementSchema),
  processes: Schema.Array(ProcessRequirementSchema),
});

/** Decode an untrusted plan document and enforce its portable contract. */
export function decodeExecutionPlan(input: unknown): ExecutionPlan {
  return Schema.decodeUnknownSync(ExecutionPlanSchema)(input) as ExecutionPlan;
}
