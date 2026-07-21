import { Plan, Service, Port, SecretValue, EnvVar, Volume, Provider, Repo, AgentHarness, PiHarness, CodexHarness, ClaudeHarness, LlmProvider } from "./plan.js";

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
  if (volume.proxy) parts.push("proxy");
  if (volume.readOnly) parts.push("read-only");
  if (volume.source) parts.push(`source ${volume.source}`);
  if (volume.bucket) parts.push(`bucket ${volume.bucket}`);
  if (volume.prefix) parts.push(`prefix ${volume.prefix}`);
  if (volume.path) parts.push(`path ${volume.path}`);
  if (volume.endpoint) parts.push(`endpoint ${volume.endpoint}`);
  if (volume.account) parts.push(`account ${volume.account}`);
  if (volume.container) parts.push(`container ${volume.container}`);
  if (volume.host) parts.push(`host ${volume.host}`);
  if (volume.port) parts.push(`port ${volume.port}`);
  if (volume.share) parts.push(`share ${volume.share}`);
  if (volume.url) parts.push(`url ${volume.url}`);
  if (volume.allowedPaths?.length) parts.push(`allowed: ${volume.allowedPaths.join(", ")}`);
  return `${volume.name} (${parts.join(", ")}) → ${volume.target}`;
}

function formatProvider(provider: Provider): string {
  const parts: string[] = [provider.type];
  const displayUrl = provider.url || provider.mcpUrl;
  if (displayUrl) parts.push(displayUrl);
  if (provider.project) parts.push(`project ${provider.project}`);
  return `${provider.name} (${parts.join(", ")})`;
}

function formatRepo(repo: Repo): string {
  const parts: string[] = [repo.url];
  parts.push(`branch ${repo.branch}`);
  if (repo.depth !== undefined) parts.push(`depth ${repo.depth}`);
  if (repo.credentials?.token) parts.push("token $VAR");
  if (repo.credentials?.sshKey) parts.push("ssh key $VAR");
  return `${repo.name} (${parts.join(", ")}) → ${repo.path}`;
}

function formatAgentHarness(harness: AgentHarness): string {
  const parts: string[] = [harness.type];
  parts.push(`port ${harness.port}`);
  if (Object.keys(harness.mcpServers).length > 0) {
    parts.push(`mcp ${Object.keys(harness.mcpServers).join(", ")}`);
  }
  if (harness.telemetry.enabled) {
    parts.push(`telemetry → ${harness.telemetry.path}`);
  }
  return `${harness.name} (${parts.join(", ")})`;
}

function formatLlmProvider(provider: LlmProvider): string {
  const parts: string[] = [];
  if (provider.npm) parts.push(`npm ${provider.npm}`);
  if (provider.displayName) parts.push(`"${provider.displayName}"`);
  const modelNames = Object.keys(provider.models);
  if (modelNames.length > 0) parts.push(`models ${modelNames.join(", ")}`);
  return `${provider.name} (${parts.join(", ")})`;
}

function formatPiHarness(harness: PiHarness): string {
  const parts: string[] = []
  if (harness.provider) parts.push(`provider ${harness.provider}`)
  if (harness.model) parts.push(`model ${harness.model}`)
  if (harness.tools && harness.tools.length > 0) parts.push(`tools ${harness.tools.join(", ")}`)
  if (harness.telemetry.enabled) parts.push(`telemetry → ${harness.telemetry.path}`)
  return `${harness.name} (${parts.join(", ")})`
}

function formatCodexHarness(harness: CodexHarness): string {
  const parts: string[] = []
  parts.push("codex")
  parts.push(`port ${harness.port}`)
  if (harness.model) parts.push(`model ${harness.model}`)
  if (Object.keys(harness.mcpServers).length > 0) {
    parts.push(`mcp ${Object.keys(harness.mcpServers).join(", ")}`)
  }
  if (harness.telemetry.enabled) parts.push(`telemetry → ${harness.telemetry.path}`)
  return `${harness.name} (${parts.join(", ")})`
}

function formatClaudeHarness(harness: ClaudeHarness): string {
  const parts: string[] = []
  if (harness.model) parts.push(`model ${harness.model}`)
  if (harness.tools && harness.tools.length > 0) parts.push(`tools ${harness.tools.join(", ")}`)
  if (harness.permissions) parts.push(`permissions ${harness.permissions}`)
  if (harness.telemetry.enabled) parts.push(`telemetry → ${harness.telemetry.path}`)
  return `${harness.name} (${parts.join(", ")})`
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

  if (plan.runtime.repos.length > 0) {
    lines.push("");
    lines.push("Repos:");
    for (const repo of plan.runtime.repos) {
      lines.push(`  - ${formatRepo(repo)}`);
    }
  }

  if (plan.runtime.agentHarnesses.length > 0) {
    lines.push("");
    lines.push("Agent harnesses:");
    for (const harness of plan.runtime.agentHarnesses) {
      lines.push(`  - ${formatAgentHarness(harness)}`);
    }
  }

  if (plan.runtime.llmProviders.length > 0) {
    lines.push("");
    lines.push("LLM providers:");
    for (const provider of plan.runtime.llmProviders) {
      lines.push(`  - ${formatLlmProvider(provider)}`);
    }
  }

  if (plan.runtime.piHarnesses.length > 0) {
    lines.push("")
    lines.push("Pi harnesses:")
    for (const harness of plan.runtime.piHarnesses) {
      lines.push(`  - ${formatPiHarness(harness)}`)
    }
  }

  if (plan.runtime.codexHarnesses.length > 0) {
    lines.push("")
    lines.push("Codex harnesses:")
    for (const harness of plan.runtime.codexHarnesses) {
      lines.push(`  - ${formatCodexHarness(harness)}`)
    }
  }

  if (plan.runtime.claudeHarnesses.length > 0) {
    lines.push("")
    lines.push("Claude harnesses:")
    for (const harness of plan.runtime.claudeHarnesses) {
      lines.push(`  - ${formatClaudeHarness(harness)}`)
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

  if (plan.runtime.providers.length > 0) {
    lines.push("");
    lines.push("Providers:");
    for (const provider of plan.runtime.providers) {
      lines.push(`  - ${formatProvider(provider)}`);
      if (provider.credentials) {
        for (const [key, value] of Object.entries(provider.credentials)) {
          lines.push(`      ${key}: ${formatSecret(value)}`);
        }
      }
      if (provider.metadata) {
        for (const [key, value] of Object.entries(provider.metadata)) {
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

  if (plan.runtime.repos.length > 0) {
    lines.push("## Repos");
    lines.push("");
    for (const repo of plan.runtime.repos) {
      lines.push(`- \`${formatRepo(repo)}\``);
    }
    lines.push("");
  }

  if (plan.runtime.agentHarnesses.length > 0) {
    lines.push("## Agent harnesses");
    lines.push("");
    for (const harness of plan.runtime.agentHarnesses) {
      lines.push(`- \`${formatAgentHarness(harness)}\``);
    }
    lines.push("");
  }

  if (plan.runtime.llmProviders.length > 0) {
    lines.push("## LLM providers");
    lines.push("");
    for (const provider of plan.runtime.llmProviders) {
      lines.push(`- \`${formatLlmProvider(provider)}\``);
    }
    lines.push("");
  }

  if (plan.runtime.piHarnesses.length > 0) {
    lines.push("## Pi harnesses")
    lines.push("")
    for (const harness of plan.runtime.piHarnesses) {
      lines.push(`- \`${formatPiHarness(harness)}\``)
    }
    lines.push("")
  }

  if (plan.runtime.codexHarnesses.length > 0) {
    lines.push("## Codex harnesses")
    lines.push("")
    for (const harness of plan.runtime.codexHarnesses) {
      lines.push(`- \`${formatCodexHarness(harness)}\``)
    }
    lines.push("")
  }

  if (plan.runtime.claudeHarnesses.length > 0) {
    lines.push("## Claude harnesses")
    lines.push("")
    for (const harness of plan.runtime.claudeHarnesses) {
      lines.push(`- \`${formatClaudeHarness(harness)}\``)
    }
    lines.push("")
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

  if (plan.runtime.providers.length > 0) {
    lines.push("## Providers");
    lines.push("");
    for (const provider of plan.runtime.providers) {
      lines.push(`### ${provider.name}`);
      lines.push("");
      lines.push(`- Type: \`${provider.type}\``);
      const displayUrl = provider.url || provider.mcpUrl;
      if (displayUrl) lines.push(`- URL: \`${displayUrl}\``);
      if (provider.project) lines.push(`- Project: \`${provider.project}\``);
      if (provider.credentials) {
        lines.push("- Credentials:");
        for (const [key, value] of Object.entries(provider.credentials)) {
          lines.push(`  - ${key}: \`${formatSecret(value)}\``);
        }
      }
      if (provider.metadata) {
        for (const [key, value] of Object.entries(provider.metadata)) {
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
