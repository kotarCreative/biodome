import { describe, it, expect } from "vitest";
import { filterProviderTools } from "../../mcp/provider-tools.js";

function makeTools(): any[] {
  return [
    { name: "get_sandbox_info" },
    { name: "get_endpoints" },
    { name: "get_providers" },
    { name: "provider_search" },
    { name: "provider_describe" },
    { name: "provider_execute" },
    { name: "exec_command" },
  ];
}

describe("filterProviderTools", () => {
  it("hides all provider tools when no providers are declared", () => {
    const tools = filterProviderTools(makeTools(), []);
    expect(tools.map((t) => t.name)).toEqual(["get_sandbox_info", "get_endpoints", "exec_command"]);
  });

  it("shows all provider tools when at least one provider is declared", () => {
    const tools = filterProviderTools(makeTools(), [{ type: "jira" }]);
    expect(tools.map((t) => t.name)).toEqual([
      "get_sandbox_info",
      "get_endpoints",
      "get_providers",
      "provider_search",
      "provider_describe",
      "provider_execute",
      "exec_command",
    ]);
  });

  it("shows provider tools regardless of provider type", () => {
    const tools = filterProviderTools(makeTools(), [{ type: "sentry" }]);
    expect(tools.map((t) => t.name)).toEqual([
      "get_sandbox_info",
      "get_endpoints",
      "get_providers",
      "provider_search",
      "provider_describe",
      "provider_execute",
      "exec_command",
    ]);
  });
});
