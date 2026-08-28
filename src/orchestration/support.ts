// Static per-driver support declarations used to derive a provider profile
// from a registered driver. These describe what each built-in provider
// supports beyond its capability set so compatibility checks can reject
// unsupported workspace strategies, service kinds, network modes, secret
// exposures, and artifact transports before any provider call.

import type { ArtifactTransport, SecretExposure, WorkspaceRequirement } from "./execution-plan.js";
import type { NetworkMode, ResourceBounds, WorkspaceStrategy } from "./compatibility.js";

export interface DriverSupportDeclaration {
  readonly workspaceStrategies?: readonly WorkspaceStrategy[];
  readonly workspaceFields?: readonly (keyof Omit<WorkspaceRequirement, "strategy">)[];
  /** In-container service kinds this provider can host in the dev image. */
  readonly processServiceKinds?: readonly string[];
  readonly networkModes?: readonly NetworkMode[];
  readonly networkAllowlist?: boolean;
  readonly secretExposures?: readonly SecretExposure[];
  readonly artifactTransports?: readonly ArtifactTransport[];
  readonly maxResources?: ResourceBounds;
  readonly supportsTaskResources?: boolean;
}

export const DRIVER_SUPPORT: Readonly<Record<string, DriverSupportDeclaration>> = {
  "docker-compose": {
    workspaceStrategies: ["bind"],
    // Only types with an in-container process implementation are supported.
    processServiceKinds: ["postgres", "redis"],
    networkModes: ["egress", "unrestricted"],
    networkAllowlist: false,
    secretExposures: ["environment", "file"],
    artifactTransports: ["local"],
    // Task resource requirements are not rendered into the Compose file.
    supportsTaskResources: false,
  },
  "docker-sandbox": {
    workspaceStrategies: ["clone", "bind"],
    processServiceKinds: ["postgres", "redis"],
    networkModes: ["egress", "unrestricted"],
    networkAllowlist: false,
    secretExposures: ["environment", "file", "agent-forwarding"],
    artifactTransports: ["local"],
    // sbx target options are not portable task resource requirements.
    supportsTaskResources: false,
  },
  "aws-ecs": {
    // Services are part of the single dev image and are therefore supported.
    processServiceKinds: ["postgres", "redis"],
    // The repository is uploaded as part of the immutable image build context.
    workspaceStrategies: ["upload"],
    workspaceFields: [],
    // Fargate awsvpc tasks always have egress; no host networking exists.
    networkModes: ["egress"],
    // Security groups cannot express per-destination allowlists.
    networkAllowlist: false,
    // The single-container ECS driver supports native environment injection.
    // Request proxies and per-agent forwarding are not cloud-wired yet.
    secretExposures: ["environment"],
    artifactTransports: ["s3"],
    // Target-level Fargate sizing is not a portable per-task resource contract.
    supportsTaskResources: false,
  },
};
