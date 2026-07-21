const PROVIDER_TOOL_NAMES = new Set([
  "get_providers",
  "provider_search",
  "provider_describe",
  "provider_execute",
])

// Filters the full MCP tool list so that provider-specific tools are only
// advertised when at least one provider is declared in the plan.
export function filterProviderTools(tools: any[], providers: any[]): any[] {
  const hasProviders = providers.length > 0
  return tools.filter((tool) => {
    if (PROVIDER_TOOL_NAMES.has(tool.name)) return hasProviders
    return true
  })
}
