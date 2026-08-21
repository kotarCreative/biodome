import { createHash } from "node:crypto";
import type { Capability } from "../core/capabilities.js";
import type { Plan, SecretValue } from "../core/plan.js";
import type { RuntimeDriver } from "../runtime/driver.js";
import {
  EXECUTION_PLAN_VERSION,
  type ArtifactTransport,
  type ExecutionPlan,
  type SecretExposure,
  type SecretRequirement,
  type WorkspaceRequirement,
} from "./execution-plan.js";
import { DRIVER_SUPPORT } from "./support.js";
import type { ProviderProfile, WorkspaceStrategy } from "./compatibility.js";

/** Compile the legacy plan into the portable contract used by orchestration. */
export function compileExecutionPlan(plan: Plan): ExecutionPlan {
  const deployment = plan.deployment;
  if (!deployment?.task) throw new Error("Cannot compile an execution plan without a task");

  const task = deployment.task;
  const driverId = deployment.target.driver;
  const workspace = task.workspace ?? defaultWorkspaceStrategy(driverId);
  const transport = artifactTransportFor(driverId);
  const capabilities: ExecutionPlan["task"]["capabilities"] = [
    {
      capability: executionCapability(driverId),
      level: "required",
      reason: "agent tasks execute a command",
    },
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
      provider: driverId,
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
      secrets: compileSecrets(plan),
      workspace,
      artifacts: task.artifacts.map((path) => ({ path, required: false, transport })),
      validationCommands: task.validationCommands ?? [],
    },
    services: plan.runtime.services.map((service) => ({
      name: service.name,
      kind: service.type,
    })),
    processes: plan.runtime.processes.map((process) => ({
      name: process.name,
      command: process.command,
      mode: process.mode,
      workingDirectory: process.workingDir,
    })),
  };
}

/** The execution capability that actually applies to a driver's task path. */
function executionCapability(driverId: string): Capability {
  switch (driverId) {
    case "aws-ecs":
      return "job.run";
    case "docker-sandbox":
    case "docker-compose":
    default:
      return "exec.inplace";
  }
}

/**
 * Select the workspace strategy a driver can safely execute with. Remote and
 * job-oriented providers are never silently defaulted to a host `bind` mount.
 */
export function defaultWorkspaceStrategy(driverId: string): WorkspaceRequirement {
  const supported = DRIVER_SUPPORT[driverId]?.workspaceStrategies;
  const fallback: Partial<Record<string, WorkspaceStrategy>> = {
    "docker-sandbox": "clone",
    "docker-compose": "bind",
    "aws-ecs": "upload",
  };
  const strategy = supported?.[0] ?? fallback[driverId];
  if (!strategy) {
    throw new Error(
      `Cannot default a workspace strategy for driver "${driverId}". Declare one in the task workspace or register a provider-specific safe default.`,
    );
  }
  return { strategy };
}

/** Map a driver to the artifact transport it uses to deliver task output. */
export function artifactTransportFor(driverId: string): ArtifactTransport | undefined {
  return DRIVER_SUPPORT[driverId]?.artifactTransports?.[0];
}

export function providerProfile(driver: RuntimeDriver): ProviderProfile {
  return {
    id: driver.id,
    capabilities: driver.capabilities,
    ...DRIVER_SUPPORT[driver.id],
  };
}

export function executionPlanDigest(plan: ExecutionPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

// --- Secret compilation ---

function envReference(secret: SecretValue | undefined): string | undefined {
  return secret && typeof secret === "object" && "env" in secret ? secret.env : undefined;
}

function compileSecrets(plan: Plan): SecretRequirement[] {
  const secrets: SecretRequirement[] = [];
  const seen = new Set<string>();

  const add = (
    name: string | undefined,
    purpose: string,
    exposure: SecretExposure,
    destinations: string[],
    required: boolean,
  ): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    secrets.push({ name, purpose, exposure, destinations, required });
  };

  for (const envVar of plan.runtime.envVars) {
    if (!envVar.from) continue;
    add(
      envVar.from.env,
      `environment variable ${envVar.key} passed through from the host`,
      "environment",
      [],
      envVar.required ?? false,
    );
  }

  for (const provider of plan.runtime.providers) {
    const destinations = provider.url ? [provider.url] : [];
    add(
      provider.authCredential,
      `authentication credential for provider ${provider.name}`,
      "request-proxy",
      destinations,
      true,
    );
    for (const [key, value] of Object.entries(provider.credentials ?? {})) {
      add(
        envReference(value),
        `credential ${key} for provider ${provider.name}`,
        "agent-forwarding",
        destinations,
        true,
      );
    }
  }

  for (const volume of plan.runtime.volumes) {
    for (const [key, value] of Object.entries(volume.credentials ?? {})) {
      add(
        envReference(value),
        `credential ${key} for volume ${volume.name}`,
        "environment",
        [],
        true,
      );
    }
  }

  for (const repo of plan.runtime.repos) {
    add(
      envReference(repo.credentials?.token),
      `repository token for ${repo.name}`,
      "environment",
      [repo.url],
      true,
    );
    add(
      envReference(repo.credentials?.sshKey),
      `repository SSH key for ${repo.name}`,
      "file",
      [repo.url],
      true,
    );
  }

  for (const endpoint of plan.runtime.endpoints) {
    const destinations = endpoint.url ? [endpoint.url] : [];
    for (const [key, value] of Object.entries(endpoint.credentials ?? {})) {
      add(
        envReference(value),
        `credential ${key} for endpoint ${endpoint.name}`,
        "agent-forwarding",
        destinations,
        true,
      );
    }
  }

  for (const harness of plan.runtime.piHarnesses) {
    add(
      envReference(harness.apiKey),
      `API key for harness ${harness.name}`,
      "agent-forwarding",
      [],
      true,
    );
  }
  for (const harness of plan.runtime.codexHarnesses) {
    add(
      envReference(harness.apiKey),
      `API key for harness ${harness.name}`,
      "agent-forwarding",
      [],
      true,
    );
  }
  for (const harness of plan.runtime.claudeHarnesses) {
    add(
      envReference(harness.apiKey),
      `API key for harness ${harness.name}`,
      "agent-forwarding",
      [],
      true,
    );
  }

  add(
    envReference(plan.build.mcpConfig?.token),
    "bearer token for the built-in MCP server",
    "request-proxy",
    [],
    true,
  );

  return secrets;
}
