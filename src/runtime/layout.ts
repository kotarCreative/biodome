import { join } from "node:path";

export interface RuntimeLayout {
  host: {
    projectRoot: string;
    targetName?: string;
    root: string;
    dockerfile: string;
    composeFile: string;
    supervisordConfig: string;
    startupScript: string;
    healthchecks: string;
    repositories: string;
    services: string;
    mcp: string;
    mcpPlan: string;
    mcpServer: string;
    artifacts: string;
    logs: string;
    state: string;
  };
  container: Omit<RuntimeLayout["host"], "projectRoot" | "targetName" | "composeFile" | "state">;
}

export function runtimeLayout(rootDir: string, targetName?: string): RuntimeLayout {
  const relativeRoot = targetName
    ? join(".biodome-build", "targets", targetName)
    : ".biodome-build";
  const hostRoot = join(rootDir, relativeRoot);
  const containerRoot = join("/workspace", relativeRoot);

  return {
    host: {
      projectRoot: rootDir,
      targetName,
      root: hostRoot,
      dockerfile: join(hostRoot, "Dockerfile"),
      composeFile: join(hostRoot, "docker-compose.yaml"),
      supervisordConfig: join(hostRoot, "supervisord.conf"),
      startupScript: join(hostRoot, "startup.sh"),
      healthchecks: join(hostRoot, "healthchecks"),
      repositories: join(hostRoot, "repos"),
      services: join(hostRoot, "services"),
      mcp: join(hostRoot, "mcp"),
      mcpPlan: join(hostRoot, "plan.json"),
      mcpServer: join(hostRoot, "mcp", "server.js"),
      artifacts: join(hostRoot, "artifacts"),
      logs: join(hostRoot, "logs"),
      state: join(hostRoot, "state.json"),
    },
    container: {
      root: containerRoot,
      dockerfile: join(containerRoot, "Dockerfile"),
      supervisordConfig: join(containerRoot, "supervisord.conf"),
      startupScript: join(containerRoot, "startup.sh"),
      healthchecks: join(containerRoot, "healthchecks"),
      repositories: join(containerRoot, "repos"),
      services: join(containerRoot, "services"),
      mcp: join(containerRoot, "mcp"),
      mcpPlan: join(containerRoot, "plan.json"),
      mcpServer: join(containerRoot, "mcp", "server.js"),
      artifacts: join(containerRoot, "artifacts"),
      logs: join(containerRoot, "logs"),
    },
  };
}
