import { Plan, Service, Port, SecretValue, EnvVar, Volume } from "./plan.js";

function formatPort(p: Port): string {
  const label = p.name ? `${p.name}: ` : "";
  return `${label}${p.host}:${p.container}`;
}

// Env-referenced credentials are shown as `$VAR` (never resolved on the host at
// build time); literal values are shown as-is.
function formatSecret(value: SecretValue): string {
  if (typeof value === "object" && value !== null && "env" in value) {
    return `$${value.env} (from environment)`;
  }
  return value;
}

// Describes a declared env var without exposing passthrough values.
function formatEnvVar(envVar: EnvVar): string {
  const scope = envVar.scope === "runtime" ? "" : ` [${envVar.scope}]`;
  if (envVar.from) {
    const parts = [`from $${envVar.from.env}`];
    if (envVar.required) parts.push("required");
    if (envVar.default !== undefined) parts.push(`default "${envVar.default}"`);
    return `${envVar.key} = ${parts.join(", ")}${scope}`;
  }
  return `${envVar.key} = ${envVar.value}${scope}`;
}

function formatVolume(volume: Volume): string {
  const parts: string[] = [volume.type];
  if (volume.source) parts.push(`source ${volume.source}`);
  if (volume.bucket) parts.push(`bucket ${volume.bucket}`);
  if (volume.key) parts.push(`key ${volume.key}`);
  if (volume.prefix) parts.push(`prefix ${volume.prefix}`);
  if (volume.path) parts.push(`path ${volume.path}`);
  return `${volume.name} (${parts.join(", ")}) → ${volume.target}`;
}

export interface ServiceConnection {
  label: string;
  internal: string;
  external: string;
}

export function serviceConnection(svc: Service): ServiceConnection | undefined {
  if (svc.type === "postgres") {
    const user = svc.environment.POSTGRES_USER || "postgres";
    const password = svc.environment.POSTGRES_PASSWORD || "postgres";
    const database = svc.environment.POSTGRES_DB || "postgres";
    const hostPort = svc.ports[0]?.host || 5432;
    return {
      label: "PostgreSQL",
      internal: `postgresql://${user}:${password}@${svc.name}:5432/${database}`,
      external: `postgresql://${user}:${password}@localhost:${hostPort}/${database}`,
    };
  }

  if (svc.type === "redis") {
    const password = svc.environment.REDIS_PASSWORD;
    const auth = password ? `:${password}@` : "";
    const hostPort = svc.ports[0]?.host || 6379;
    return {
      label: "Redis",
      internal: `redis://${auth}${svc.name}:6379/0`,
      external: `redis://${auth}localhost:${hostPort}/0`,
    };
  }

  return undefined;
}

export function formatInfo(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Project: ${plan.project}`);
  lines.push(`Base image: ${plan.build.baseImage || "(default debian:12-slim)"}`);

  if (plan.build.languageRequests.length > 0) {
    lines.push("");
    lines.push("Languages:");
    for (const request of plan.build.languageRequests) {
      const opts = [];
      if (request.options.version) opts.push(`version ${request.options.version}`);
      if (request.options.packageManager) opts.push(request.options.packageManager);
      const suffix = opts.length > 0 ? ` (${opts.join(", ")})` : "";
      lines.push(`  - ${request.name}${suffix}`);
    }
  }

  if (plan.build.aptPackages.length > 0) {
    lines.push("");
    lines.push("System packages:");
    for (const pkg of plan.build.aptPackages) {
      lines.push(`  - ${pkg}`);
    }
  }

  if (plan.runtime.services.length > 0) {
    lines.push("");
    lines.push("Services:");
    for (const svc of plan.runtime.services) {
      const port = svc.ports.map(formatPort).join(", ") || "none";
      lines.push(`  - ${svc.name} (${svc.image}) ports ${port}`);
      const conn = serviceConnection(svc);
      if (conn) {
        lines.push(`      internal: ${conn.internal}`);
        lines.push(`      external: ${conn.external}`);
      }
    }
  }

  if (plan.runtime.volumes.length > 0) {
    lines.push("");
    lines.push("Volumes:");
    for (const volume of plan.runtime.volumes) {
      lines.push(`  - ${formatVolume(volume)}`);
    }
  }

  if (plan.runtime.endpoints.length > 0) {
    lines.push("");
    lines.push("Endpoints:");
    for (const endpoint of plan.runtime.endpoints) {
      const target = endpoint.url || (endpoint.port ? `port ${endpoint.port}` : "");
      const suffix = target ? ` (${target})` : "";
      lines.push(`  - ${endpoint.name}${suffix}`);
      if (endpoint.description) {
        lines.push(`      ${endpoint.description}`);
      }
      if (endpoint.credentials) {
        for (const [key, value] of Object.entries(endpoint.credentials)) {
          lines.push(`      ${key}: ${formatSecret(value)}`);
        }
      }
      if (endpoint.metadata) {
        for (const [key, value] of Object.entries(endpoint.metadata)) {
          lines.push(`      ${key}: ${value}`);
        }
      }
    }
  }

  if (plan.runtime.envVars.length > 0) {
    lines.push("");
    lines.push("Environment:");
    for (const envVar of plan.runtime.envVars) {
      lines.push(`  - ${formatEnvVar(envVar)}`);
    }
  }

  if (plan.runtime.processes.length > 0) {
    const daemons = plan.runtime.processes.filter((p) => p.mode === "daemon");
    const hooks = plan.runtime.processes.filter((p) => p.mode === "oneshot");

    if (daemons.length > 0) {
      lines.push("");
      lines.push("Processes:");
      for (const proc of daemons) {
        const port = proc.ports.map(formatPort).join(", ") || "none";
        lines.push(`  - ${proc.name}: ${proc.command.join(" ")} (ports: ${port})`);
      }
    }

    if (hooks.length > 0) {
      lines.push("");
      lines.push("Hooks:");
      for (const hook of hooks) {
        lines.push(`  - ${hook.name}: ${hook.command.join(" ")} @ ${hook.startOn}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

export function formatAgentsMd(plan: Plan): string {
  const lines: string[] = [];
  lines.push("# Development Environment");
  lines.push("");
  lines.push(`Auto-generated by biodome for \`${plan.project}\`.`);
  lines.push("");
  lines.push("## Base image");
  lines.push("");
  lines.push(`- ${plan.build.baseImage || "debian:12-slim"}`);
  lines.push("");

  if (plan.build.languageRequests.length > 0) {
    lines.push("## Languages");
    lines.push("");
    for (const request of plan.build.languageRequests) {
      const opts = [];
      if (request.options.version) opts.push(`version ${request.options.version}`);
      if (request.options.packageManager) opts.push(request.options.packageManager);
      const suffix = opts.length > 0 ? ` (${opts.join(", ")})` : "";
      lines.push(`- ${request.name}${suffix}`);
    }
    lines.push("");
  }

  if (plan.build.aptPackages.length > 0) {
    lines.push("## System packages");
    lines.push("");
    for (const pkg of plan.build.aptPackages) {
      lines.push(`- ${pkg}`);
    }
    lines.push("");
  }

  if (plan.runtime.services.length > 0) {
    lines.push("## Services");
    lines.push("");
    for (const svc of plan.runtime.services) {
      lines.push(`### ${svc.name}`);
      lines.push("");
      lines.push(`- Image: \`${svc.image}\``);
      if (svc.ports.length > 0) {
        lines.push(`- Ports: ${svc.ports.map((p) => `\`${formatPort(p)}\``).join(", ")}`);
      }
      const conn = serviceConnection(svc);
      if (conn) {
        lines.push(`- Internal: \`${conn.internal}\``);
        lines.push(`- External: \`${conn.external}\``);
      }
      lines.push("");
    }
  }

  if (plan.runtime.volumes.length > 0) {
    lines.push("## Volumes");
    lines.push("");
    for (const volume of plan.runtime.volumes) {
      lines.push(`- \`${formatVolume(volume)}\``);
    }
    lines.push("");
  }

  if (plan.runtime.endpoints.length > 0) {
    lines.push("## Endpoints");
    lines.push("");
    for (const endpoint of plan.runtime.endpoints) {
      lines.push(`### ${endpoint.name}`);
      lines.push("");
      if (endpoint.description) {
        lines.push(endpoint.description);
        lines.push("");
      }
      if (endpoint.url) lines.push(`- URL: \`${endpoint.url}\``);
      if (endpoint.port !== undefined) lines.push(`- Port: \`${endpoint.port}\``);
      if (endpoint.credentials) {
        lines.push("- Credentials:");
        for (const [key, value] of Object.entries(endpoint.credentials)) {
          lines.push(`  - ${key}: \`${formatSecret(value)}\``);
        }
      }
      if (endpoint.metadata) {
        for (const [key, value] of Object.entries(endpoint.metadata)) {
          lines.push(`- ${key}: \`${value}\``);
        }
      }
      lines.push("");
    }
  }

  if (plan.runtime.envVars.length > 0) {
    lines.push("## Environment");
    lines.push("");
    for (const envVar of plan.runtime.envVars) {
      lines.push(`- \`${formatEnvVar(envVar)}\``);
    }
    lines.push("");
  }

  if (plan.runtime.processes.length > 0) {
    const daemons = plan.runtime.processes.filter((p) => p.mode === "daemon");
    const hooks = plan.runtime.processes.filter((p) => p.mode === "oneshot");

    if (daemons.length > 0) {
      lines.push("## Processes");
      lines.push("");
      for (const proc of daemons) {
        lines.push(`- **${proc.name}**: \`${proc.command.join(" ")}\``);
        if (proc.ports.length > 0) {
          lines.push(`  - Ports: ${proc.ports.map((p) => `\`${formatPort(p)}\``).join(", ")}`);
        }
      }
      lines.push("");
    }

    if (hooks.length > 0) {
      lines.push("## Hooks");
      lines.push("");
      for (const hook of hooks) {
        lines.push(`- \`${hook.startOn}\`: \`${hook.command.join(" ")}\``);
      }
      lines.push("");
    }
  }

  lines.push("## Common commands");
  lines.push("");
  lines.push("- `biodome up` — start the environment");
  lines.push("- `biodome down` — stop the environment");
  lines.push("- `biodome exec <command>` — run a command in the dev container");
  lines.push("- `biodome info` — show this summary");
  lines.push("");

  return lines.join("\n");
}
