// Static per-driver support declarations used to derive a provider profile
// from a registered driver. These describe what each built-in provider
// supports beyond its capability set so compatibility checks can reject
// unsupported workspace strategies, service kinds, network modes, secret
// exposures, and artifact transports before any provider call.

import type { ArtifactTransport, SecretExposure } from "./execution-plan.js";
import type { NetworkMode, ResourceBounds, WorkspaceStrategy } from "./compatibility.js";

export interface DriverSupportDeclaration {
  readonly workspaceStrategies?: readonly WorkspaceStrategy[];
  readonly serviceKinds?: readonly string[];
  readonly networkModes?: readonly NetworkMode[];
  readonly secretExposures?: readonly SecretExposure[];
  readonly artifactTransports?: readonly ArtifactTransport[];
  readonly maxResources?: ResourceBounds;
}

export const DRIVER_SUPPORT: Readonly<Record<string, DriverSupportDeclaration>> = {
  "docker-compose": {
    workspaceStrategies: ["bind"],
    networkModes: ["egress", "unrestricted"],
    secretExposures: ["environment", "file"],
    artifactTransports: ["local"],
  },
  "docker-sandbox": {
    workspaceStrategies: ["clone", "bind"],
    networkModes: ["egress", "unrestricted"],
    secretExposures: ["environment", "file", "agent-forwarding"],
    artifactTransports: ["local"],
  },
  "aws-ecs": {
    // Fargate cannot host backing service containers yet.
    serviceKinds: [],
    workspaceStrategies: ["upload"],
    networkModes: ["egress"],
    secretExposures: ["environment", "request-proxy", "agent-forwarding"],
    artifactTransports: ["s3"],
  },
};
