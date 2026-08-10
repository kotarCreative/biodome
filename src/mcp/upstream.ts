import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface UpstreamProvider {
  name: string;
  type: string;
  mcpUrl: string;
  authHeader: string;
  authScheme: string;
  token: string;
}

export interface CatalogEntry {
  provider: string;
  tool: string;
  qualified: string;
  description: string;
  inputSchema: unknown;
}

export interface ProviderError {
  provider: string;
  error: string;
}

export interface UpstreamRegistryOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  catalogConcurrency?: number;
}

export type ConnectFn = (p: UpstreamProvider) => Promise<Client>;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_CONCURRENCY = 4;

export async function defaultConnect(p: UpstreamProvider): Promise<Client> {
  const client = new Client({ name: "biodome-mcp", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(p.mcpUrl), {
    requestInit: {
      headers: { [p.authHeader]: `${p.authScheme}${p.token}` },
    },
  });
  await client.connect(transport);
  return client;
}

export function parseQualified(qualified: string): { provider: string; tool: string } {
  const dot = qualified.indexOf(".");
  if (dot === -1) {
    throw new Error(`Invalid qualified tool name "${qualified}": expected "provider.tool" format`);
  }
  return { provider: qualified.slice(0, dot), tool: qualified.slice(dot + 1) };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function redactError(error: unknown, provider: UpstreamProvider): string {
  let message = error instanceof Error ? error.message : String(error);
  if (provider.token) {
    message = message.replaceAll(provider.token, "[REDACTED]");
  }
  message = message.replace(
    /(authorization|proxy-authorization)\s*[:=]\s*[^,;\r\n]+/gi,
    "$1: [REDACTED]",
  );
  message = message.replace(/([?&](?:access_token|api[_-]?key|token)=)[^&#\s]+/gi, "$1[REDACTED]");
  return message;
}

export class UpstreamRegistry {
  private readonly clients = new Map<string, Client>();
  private readonly clientPromises = new Map<string, Promise<Client>>();
  private completedCatalog: CatalogEntry[] | null = null;
  private completedErrors: ProviderError[] = [];
  private refreshPromise: Promise<CatalogEntry[]> | null = null;
  private closed = false;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly catalogConcurrency: number;

  constructor(
    private readonly providers: UpstreamProvider[],
    private readonly connectFn: ConnectFn = defaultConnect,
    options: UpstreamRegistryOptions = {},
  ) {
    this.connectTimeoutMs = positive(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.requestTimeoutMs = positive(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.catalogConcurrency = Math.floor(
      positive(options.catalogConcurrency, DEFAULT_CATALOG_CONCURRENCY),
    );
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
    onTimeout?: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(message));
      }, timeoutMs);
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private provider(providerName: string): UpstreamProvider {
    const provider = this.providers.find((candidate) => candidate.name === providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);
    return provider;
  }

  private async ensureConnected(providerName: string): Promise<Client> {
    const existing = this.clientPromises.get(providerName);
    if (existing) return existing;
    if (this.closed) throw new Error("Upstream registry is closed");

    const provider = this.provider(providerName);
    const connecting = this.connectFn(provider);
    const connection = this.withDeadline(
      connecting,
      this.connectTimeoutMs,
      `Provider "${providerName}" connection timed out`,
      () => {
        void connecting.then((client) => client.close()).catch(() => {});
      },
    );
    this.clientPromises.set(providerName, connection);
    try {
      const client = await connection;
      if (this.closed) {
        await client.close();
        throw new Error("Upstream registry is closed");
      }
      this.clients.set(providerName, client);
      return client;
    } catch (error) {
      if (this.clientPromises.get(providerName) === connection) {
        this.clientPromises.delete(providerName);
      }
      throw error;
    }
  }

  private async request<T>(
    providerName: string,
    client: Client,
    operation: Promise<T>,
  ): Promise<T> {
    return this.withDeadline(
      operation,
      this.requestTimeoutMs,
      `Provider "${providerName}" request timed out`,
      () => {
        this.clients.delete(providerName);
        this.clientPromises.delete(providerName);
        void client.close().catch(() => {});
      },
    );
  }

  private async catalogFor(
    provider: UpstreamProvider,
  ): Promise<{ entries: CatalogEntry[]; error?: ProviderError }> {
    try {
      const client = await this.ensureConnected(provider.name);
      const result = await this.request(provider.name, client, client.listTools());
      return {
        entries: (result.tools ?? []).map((tool) => ({
          provider: provider.name,
          tool: tool.name,
          qualified: `${provider.name}.${tool.name}`,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        })),
      };
    } catch (error) {
      return {
        entries: [],
        error: { provider: provider.name, error: redactError(error, provider) },
      };
    }
  }

  private async buildCatalog(): Promise<CatalogEntry[]> {
    const results: { entries: CatalogEntry[]; error?: ProviderError }[] = Array.from(
      { length: this.providers.length },
      () => ({ entries: [] }),
    );
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= this.providers.length) return;
        results[index] = await this.catalogFor(this.providers[index]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.catalogConcurrency, this.providers.length) }, worker),
    );

    const catalog = results.flatMap((result) => result.entries);
    catalog.sort((a, b) =>
      a.provider === b.provider
        ? a.tool.localeCompare(b.tool)
        : a.provider.localeCompare(b.provider),
    );
    const errors = results.flatMap((result) => (result.error ? [result.error] : []));
    this.completedCatalog = catalog;
    this.completedErrors = errors;
    return catalog;
  }

  async listCatalog(): Promise<CatalogEntry[]> {
    if (this.completedCatalog) return this.completedCatalog;
    if (!this.refreshPromise) {
      this.refreshPromise = this.buildCatalog().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async refreshCatalog(): Promise<CatalogEntry[]> {
    if (this.refreshPromise) return this.completedCatalog ?? this.refreshPromise;
    this.refreshPromise = this.buildCatalog().finally(() => {
      this.refreshPromise = null;
    });
    return this.completedCatalog ?? this.refreshPromise;
  }

  async describe(qualified: string): Promise<CatalogEntry> {
    const { provider: providerName } = parseQualified(qualified);
    const cached = this.completedCatalog?.find((entry) => entry.qualified === qualified);
    if (cached) return cached;

    const provider = this.provider(providerName);
    const client = await this.ensureConnected(providerName);
    const result = await this.request(providerName, client, client.listTools());
    const tool = result.tools?.find(
      (candidate) => `${providerName}.${candidate.name}` === qualified,
    );
    if (!tool) throw new Error(`Tool "${qualified}" not found in provider "${providerName}"`);
    return {
      provider: provider.name,
      tool: tool.name,
      qualified,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    };
  }

  async call(qualified: string, args: unknown): Promise<unknown> {
    const { provider: providerName, tool } = parseQualified(qualified);
    const client = await this.ensureConnected(providerName);
    return this.request(
      providerName,
      client,
      client.callTool({ name: tool, arguments: (args as Record<string, unknown>) ?? {} }),
    );
  }

  getErrors(): ProviderError[] {
    return [...this.completedErrors];
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        try {
          await client.close();
        } catch {
          // best-effort close
        }
      }),
    );
    this.clients.clear();
    this.clientPromises.clear();
    this.completedCatalog = null;
    this.completedErrors = [];
  }
}
