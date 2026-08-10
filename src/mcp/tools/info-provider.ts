import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpPlan } from "../plan.js";
import type { ProviderRegistry } from "../application.js";
import { text, type ToolDefinition } from "./types.js";

export function createInfoProviderTools(
  plan: McpPlan,
  registry: ProviderRegistry,
  maxListEntries: number,
  skipped: readonly string[],
): readonly ToolDefinition[] {
  const empty = { type: "object", properties: {} };
  return [
    {
      name: "get_sandbox_info",
      description:
        "Get a description of the current sandbox setup: project, languages, services, processes, ports, and connection strings.",
      inputSchema: empty,
      handler: async () => text(JSON.stringify(plan, null, 2)),
    },
    {
      name: "get_endpoints",
      description:
        "List the feature-declared endpoints (custom APIs and services) with their URLs, ports, and metadata.",
      inputSchema: empty,
      handler: async () =>
        text(
          JSON.stringify(
            plan.endpoints.map(({ name, description, url, port, metadata }) => ({
              name,
              description: description ?? null,
              url: url ?? null,
              port: port ?? null,
              metadata: metadata ?? null,
            })),
            null,
            2,
          ),
        ),
    },
    {
      name: "get_providers",
      description:
        "List the feature-declared external providers (e.g. Jira, GitHub, Slack) with their type and metadata.",
      inputSchema: empty,
      handler: async () =>
        text(
          JSON.stringify(
            plan.providers.map(({ name, type, url, project, metadata }) => ({
              name,
              type,
              url: url ?? null,
              project: project ?? null,
              metadata: metadata ?? null,
            })),
            null,
            2,
          ),
        ),
    },
    {
      name: "provider_search",
      description: "Search across all connected provider tools.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          provider: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (args) => {
        const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
        const provider = typeof args.provider === "string" ? args.provider : undefined;
        const limit =
          typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), maxListEntries) : 20;
        const catalog = await registry.listCatalog();
        const results = catalog
          .filter(
            (entry) =>
              (!provider || entry.provider === provider) &&
              (!query ||
                entry.qualified.toLowerCase().includes(query) ||
                entry.description.toLowerCase().includes(query)),
          )
          .slice(0, limit)
          .map(({ qualified: tool, provider: providerName, description }) => ({
            tool,
            provider: providerName,
            description,
          }));
        return text(JSON.stringify({ results, errors: registry.getErrors(), skipped }, null, 2));
      },
    },
    {
      name: "provider_describe",
      description: "Get the full input schema and description for one provider tool.",
      inputSchema: { type: "object", properties: { tool: { type: "string" } }, required: ["tool"] },
      handler: async (args) => {
        if (typeof args.tool !== "string" || !args.tool)
          throw new McpError(ErrorCode.InvalidParams, "tool is required");
        return text(JSON.stringify(await registry.describe(args.tool), null, 2));
      },
    },
    {
      name: "provider_execute",
      description: "Execute one provider tool by its qualified name with arguments.",
      inputSchema: {
        type: "object",
        properties: { tool: { type: "string" }, arguments: { type: "object" } },
        required: ["tool"],
      },
      handler: async (args) => {
        if (typeof args.tool !== "string" || !args.tool)
          throw new McpError(ErrorCode.InvalidParams, "tool is required");
        const input =
          args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
            ? Object.fromEntries(Object.entries(args.arguments))
            : {};
        return text(JSON.stringify(await registry.call(args.tool, input), null, 2));
      },
    },
  ];
}
