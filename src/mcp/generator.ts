import { Plan, Volume, SecretValue } from "../core/plan.js"
import { serviceConnection } from "../core/info.js"

function serializeCredential(value: SecretValue | undefined): string | { env: string } | null {
  if (value === undefined) return null
  if (typeof value === "string") return value
  return { env: value.env }
}

function serializeVolume(volume: Volume) {
  return {
    name: volume.name,
    type: volume.type,
    target: volume.target,
    proxy: volume.proxy ?? false,
    readOnly: volume.readOnly ?? false,
    allowedPaths: volume.allowedPaths ?? [],
    source: volume.source ?? null,
    bucket: volume.bucket ?? null,
    prefix: volume.prefix ?? null,
    path: volume.path ?? null,
    endpoint: volume.endpoint ?? null,
    account: volume.account ?? null,
    container: volume.container ?? null,
    host: volume.host ?? null,
    port: volume.port ?? null,
    share: volume.share ?? null,
    url: volume.url ?? null,
    vendor: volume.vendor ?? null,
    credentials: volume.credentials
      ? Object.fromEntries(
          Object.entries(volume.credentials)
            .map(([key, value]) => [key, serializeCredential(value)])
            .filter(([, value]) => value !== null)
        )
      : {},
  }
}

export function generatePlanJson(plan: Plan): string {
  const data = {
    project: plan.project,
    languages: plan.build.languageRequests.map((r) => ({
      name: r.name,
      version: r.options.version,
      packageManager: r.options.packageManager,
    })),
    services: plan.runtime.services.map((svc) => ({
      name: svc.name,
      type: svc.type,
      image: svc.image,
      ports: svc.ports.map((p) => ({ host: p.host, container: p.container })),
      connection: serviceConnection(svc) || null,
    })),
    processes: plan.runtime.processes.map((proc) => ({
      name: proc.name,
      command: proc.command,
      ports: proc.ports,
      mode: proc.mode,
      startOn: proc.startOn,
    })),
    // Endpoints are emitted verbatim. Credential values that are { env: "VAR" }
    // references stay as references here, so secrets are never written to disk;
    // the MCP server resolves them from the live container env on request.
    endpoints: plan.runtime.endpoints.map((endpoint) => ({
      name: endpoint.name,
      description: endpoint.description ?? null,
      url: endpoint.url ?? null,
      port: endpoint.port ?? null,
      credentials: endpoint.credentials ?? null,
      metadata: endpoint.metadata ?? null,
    })),
    // `environment` holds only literal values. Passthrough vars are described
    // structurally below as references, so their secret values never touch disk.
    environment: plan.runtime.environment,
    envVars: plan.runtime.envVars.map((envVar) => ({
      key: envVar.key,
      scope: envVar.scope,
      source: envVar.from ? "passthrough" : "literal",
      from: envVar.from ? envVar.from.env : null,
      required: envVar.required ?? false,
      hasDefault: envVar.default !== undefined,
    })),
    volumes: plan.runtime.volumes.map(serializeVolume),
  }
  return JSON.stringify(data, null, 2)
}
