import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export interface UpstreamProvider {
  name: string
  type: string
  mcpUrl: string
  authHeader: string
  authScheme: string
  token: string
}

export interface CatalogEntry {
  provider: string
  tool: string
  qualified: string
  description: string
  inputSchema: unknown
}

export interface ProviderError {
  provider: string
  error: string
}

export type ConnectFn = (p: UpstreamProvider) => Promise<Client>

export async function defaultConnect(p: UpstreamProvider): Promise<Client> {
  const client = new Client(
    { name: "biodome-mcp", version: "1.0.0" },
    { capabilities: {} }
  )
  const transport = new StreamableHTTPClientTransport(new URL(p.mcpUrl), {
    requestInit: {
      headers: { [p.authHeader]: `${p.authScheme}${p.token}` },
    },
  })
  await client.connect(transport)
  return client
}

export function parseQualified(qualified: string): { provider: string; tool: string } {
  const dot = qualified.indexOf(".")
  if (dot === -1) {
    throw new Error(`Invalid qualified tool name "${qualified}": expected "provider.tool" format`)
  }
  return { provider: qualified.slice(0, dot), tool: qualified.slice(dot + 1) }
}

export class UpstreamRegistry {
  private providers: UpstreamProvider[]
  private connectFn: ConnectFn
  private clients: Map<string, Client> = new Map()
  private connected: Map<string, boolean> = new Map()
  private catalogCache: CatalogEntry[] | null = null
  private errors: ProviderError[] = []

  constructor(providers: UpstreamProvider[], connectFn?: ConnectFn) {
    this.providers = providers
    this.connectFn = connectFn ?? defaultConnect
  }

  private async ensureConnected(providerName: string): Promise<Client> {
    if (this.connected.get(providerName)) {
      const existing = this.clients.get(providerName)
      if (existing) return existing
    }
    const p = this.providers.find((p) => p.name === providerName)
    if (!p) {
      throw new Error(`Unknown provider: ${providerName}`)
    }
    const client = await this.connectFn(p)
    this.clients.set(providerName, client)
    this.connected.set(providerName, true)
    return client
  }

  async listCatalog(): Promise<CatalogEntry[]> {
    if (this.catalogCache) return this.catalogCache
    this.errors = []
    this.catalogCache = []

    for (const p of this.providers) {
      try {
        const client = await this.ensureConnected(p.name)
        const result = await client.listTools()
        if (result.tools) {
          for (const tool of result.tools) {
            this.catalogCache.push({
              provider: p.name,
              tool: tool.name,
              qualified: `${p.name}.${tool.name}`,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema,
            })
          }
        }
      } catch (err) {
        this.errors.push({ provider: p.name, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return this.catalogCache
  }

  async describe(qualified: string): Promise<CatalogEntry> {
    const { provider: providerName } = parseQualified(qualified)

    if (this.catalogCache) {
      const entry = this.catalogCache.find((e) => e.qualified === qualified)
      if (entry) return entry
    }

    const p = this.providers.find((p) => p.name === providerName)
    if (!p) {
      throw new Error(`Provider "${providerName}" not found in registry`)
    }

    const client = await this.ensureConnected(providerName)
    const result = await client.listTools()
    if (result.tools) {
      const tool = result.tools.find((t) => `${providerName}.${t.name}` === qualified)
      if (tool) {
        const entry: CatalogEntry = {
          provider: providerName,
          tool: tool.name,
          qualified,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        }
        if (this.catalogCache) {
          const existing = this.catalogCache.find((e) => e.qualified === qualified)
          if (!existing) this.catalogCache.push(entry)
        }
        return entry
      }
    }

    throw new Error(`Tool "${qualified}" not found in provider "${providerName}"`)
  }

  async call(qualified: string, args: unknown): Promise<unknown> {
    const { provider: providerName, tool } = parseQualified(qualified)
    const client = await this.ensureConnected(providerName)
    const result = await client.callTool({ name: tool, arguments: args as Record<string, unknown> ?? {} })
    return result
  }

  getErrors(): ProviderError[] {
    return [...this.errors]
  }

  async close(): Promise<void> {
    for (const [, client] of this.clients) {
      try {
        await client.close()
      } catch {
        // best-effort close
      }
    }
    this.clients.clear()
    this.connected.clear()
    this.catalogCache = null
  }
}
