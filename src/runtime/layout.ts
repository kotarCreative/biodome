import { join } from "node:path";

export interface RuntimeLayout {
  host: {
    root: string;
    dockerfile: string;
    composeFile: string;
    supervisordConfig: string;
    healthchecks: string;
    repositories: string;
    mcpPlan: string;
    mcpServer: string;
    opencodeHomes: string;
    piHomes: string;
    codexHomes: string;
    claudeHomes: string;
    artifacts: string;
    logs: string;
    state: string;
  };
  container: Omit<RuntimeLayout["host"], "composeFile" | "state">;
}

export function runtimeLayout(rootDir: string, targetName?: string): RuntimeLayout {
  const relativeRoot = targetName
    ? join(".biodome-build", "targets", targetName)
    : ".biodome-build";
  const hostRoot = join(rootDir, relativeRoot);
  const containerRoot = join("/workspace", relativeRoot);

  return {
    host: {
      root: hostRoot,
      dockerfile: join(hostRoot, "Dockerfile"),
      composeFile: join(hostRoot, "docker-compose.yaml"),
      supervisordConfig: join(hostRoot, "supervisord.conf"),
      healthchecks: join(hostRoot, "healthchecks"),
      repositories: join(hostRoot, "repos"),
      mcpPlan: join(hostRoot, "plan.json"),
      mcpServer: join(hostRoot, "mcp-server.js"),
      opencodeHomes: join(hostRoot, "opencode-homes"),
      piHomes: join(hostRoot, "pi-homes"),
      codexHomes: join(hostRoot, "codex-homes"),
      claudeHomes: join(hostRoot, "claude-homes"),
      artifacts: join(hostRoot, "artifacts"),
      logs: join(hostRoot, "logs"),
      state: join(hostRoot, "state.json"),
    },
    container: {
      root: containerRoot,
      dockerfile: join(containerRoot, "Dockerfile"),
      supervisordConfig: join(containerRoot, "supervisord.conf"),
      healthchecks: join(containerRoot, "healthchecks"),
      repositories: join(containerRoot, "repos"),
      mcpPlan: join(containerRoot, "plan.json"),
      mcpServer: join(containerRoot, "mcp-server.js"),
      opencodeHomes: join(containerRoot, "opencode-homes"),
      piHomes: join(containerRoot, "pi-homes"),
      codexHomes: join(containerRoot, "codex-homes"),
      claudeHomes: join(containerRoot, "claude-homes"),
      artifacts: join(containerRoot, "artifacts"),
      logs: join(containerRoot, "logs"),
    },
  };
}
