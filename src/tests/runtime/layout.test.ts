import { describe, expect, it } from "vitest";
import { runtimeLayout } from "../../runtime/layout.js";

describe("runtimeLayout", () => {
  it.each([
    [undefined, "/project/.biodome-build", "/workspace/.biodome-build"],
    ["local", "/project/.biodome-build/targets/local", "/workspace/.biodome-build/targets/local"],
  ])("creates a complete layout for %s", (targetName, hostRoot, containerRoot) => {
    const layout = runtimeLayout("/project", targetName);

    expect(layout.host.root).toBe(hostRoot);
    expect(layout.host.dockerfile).toBe(`${hostRoot}/Dockerfile`);
    expect(layout.host.composeFile).toBe(`${hostRoot}/docker-compose.yaml`);
    expect(layout.host.supervisordConfig).toBe(`${hostRoot}/supervisord.conf`);
    expect(layout.host.healthchecks).toBe(`${hostRoot}/healthchecks`);
    expect(layout.host.repositories).toBe(`${hostRoot}/repos`);
    expect(layout.host.mcp).toBe(`${hostRoot}/mcp`);
    expect(layout.host.mcpPlan).toBe(`${hostRoot}/plan.json`);
    expect(layout.host.mcpServer).toBe(`${hostRoot}/mcp/server.js`);
    expect(layout.host.artifacts).toBe(`${hostRoot}/artifacts`);
    expect(layout.host.logs).toBe(`${hostRoot}/logs`);
    expect(layout.host.state).toBe(`${hostRoot}/state.json`);
    expect(layout.container.root).toBe(containerRoot);
    expect(layout.container.supervisordConfig).toBe(`${containerRoot}/supervisord.conf`);
    expect(layout.container.mcp).toBe(`${containerRoot}/mcp`);
    expect(layout.container.mcpServer).toBe(`${containerRoot}/mcp/server.js`);
    expect(layout.container.logs).toBe(`${containerRoot}/logs`);
  });
});
