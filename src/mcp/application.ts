import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { authenticateBearer } from "./auth.js";
import { createFileMcpEventSink } from "./event-sink.js";
import type { McpPlan } from "./plan.js";
import { resolvePlanSecret } from "./plan.js";
import {
  UpstreamRegistry,
  type CatalogEntry,
  type ProviderError,
  type UpstreamProvider,
} from "./upstream.js";
import type { VolumeConfig } from "./volumes/adapter.js";
import { VolumeAccessError } from "./volumes/adapter.js";
import { createInfoProviderTools } from "./tools/info-provider.js";
import {
  createProcessLogTools,
  type ProcessRunner,
  type ServiceProbe,
} from "./tools/process-logs.js";
import { createVolumeTools, type VolumeAdapterFactory } from "./tools/volumes.js";
import type { TextResult, ToolArguments, ToolDefinition } from "./tools/types.js";

export interface ProviderRegistry {
  listCatalog(): Promise<CatalogEntry[]>;
  describe(qualified: string): Promise<CatalogEntry>;
  call(qualified: string, arguments_: Record<string, unknown>): Promise<unknown>;
  getErrors(): ProviderError[];
  close(): Promise<void>;
}
export interface McpEventSink {
  write(type: string, data: Readonly<Record<string, unknown>>): Promise<void>;
  close?(): Promise<void>;
}
export interface McpApplicationDependencies {
  readonly volumeAdapters: VolumeAdapterFactory;
  readonly providers: ProviderRegistry;
  readonly processRunner: ProcessRunner;
  readonly probeService: ServiceProbe;
  readonly events: McpEventSink;
  readonly uuid: () => string;
  readonly now: () => Date;
}
export interface McpApplication {
  readonly handler: http.RequestListener;
  readonly tools: readonly ToolDefinition[];
  invoke(name: string, arguments_?: ToolArguments): Promise<TextResult>;
  close(): Promise<void>;
}

function asVolume(config: McpPlan["volumes"][number]): VolumeConfig {
  const credentials = config.credentials
    ? Object.fromEntries(
        Object.entries(config.credentials).filter(
          (entry): entry is [string, string | { readonly env: string }] => entry[1] !== null,
        ),
      )
    : undefined;
  return {
    ...config,
    credentials,
    allowedPaths: config.allowedPaths ? [...config.allowedPaths] : undefined,
    source: config.source ?? undefined,
    bucket: config.bucket ?? undefined,
    prefix: config.prefix ?? undefined,
    path: config.path ?? undefined,
    endpoint: config.endpoint ?? undefined,
    account: config.account ?? undefined,
    container: config.container ?? undefined,
    host: config.host ?? undefined,
    port: config.port ?? undefined,
    share: config.share ?? undefined,
    url: config.url ?? undefined,
    vendor: config.vendor ?? undefined,
  };
}
export function buildUpstreams(
  plan: McpPlan,
  environment: NodeJS.ProcessEnv,
): { readonly providers: UpstreamProvider[]; readonly skipped: string[] } {
  const providers: UpstreamProvider[] = [];
  const skipped: string[] = [];
  for (const provider of plan.providers) {
    if (!provider.mcpUrl) {
      skipped.push(`${provider.name}: no mcpUrl configured`);
      continue;
    }
    const key = provider.authCredential ?? "token";
    const token = resolvePlanSecret(provider.credentials?.[key], environment);
    if (!token) {
      skipped.push(`${provider.name}: credential ${key} not resolvable`);
      continue;
    }
    providers.push({
      name: provider.name,
      type: provider.type,
      mcpUrl: provider.mcpUrl,
      authHeader: provider.authHeader ?? "Authorization",
      authScheme: provider.authScheme ?? "Bearer ",
      token,
    });
  }
  return { providers, skipped };
}

export async function createMcpApplication(
  plan: McpPlan,
  dependencies: McpApplicationDependencies,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<McpApplication> {
  const token = resolvePlanSecret(plan.mcp.token, environment);
  const maxReadBytes = plan.mcp.maxReadBytes ?? 1048576;
  const maxWriteBytes = plan.mcp.maxWriteBytes ?? 2097152;
  const maxListEntries = plan.mcp.maxListEntries ?? 100;
  const skipped = buildUpstreams(plan, environment).skipped;
  const volumeTools = createVolumeTools(plan.volumes.map(asVolume), dependencies.volumeAdapters, {
    read: maxReadBytes,
    write: maxWriteBytes,
    list: maxListEntries,
  });
  const tools = [
    ...createInfoProviderTools(plan, dependencies.providers, maxListEntries, skipped),
    ...createProcessLogTools(
      plan,
      dependencies.processRunner,
      dependencies.probeService,
      plan.mcp.allowExec === true,
      plan.mcp.allowProcessControl === true,
    ),
    ...volumeTools.tools,
  ];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const invoke = async (name: string, arguments_: ToolArguments = {}) => {
    const tool = toolMap.get(name);
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, "Unknown tool: " + name);
    try {
      const result = await tool.handler(arguments_);
      const event = {
        id: dependencies.uuid(),
        timestamp: dependencies.now().toISOString(),
        tool: name,
      };
      console.log(JSON.stringify({ type: "mcp_call", ...event }));
      await dependencies.events.write("tool.call", event);
      await dependencies.events.write("tool.result", event);
      return result;
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (error instanceof VolumeAccessError)
        throw new McpError(ErrorCode.InvalidParams, error.message);
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const server = new Server(
    { name: "biodome-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    invoke(request.params.name, request.params.arguments ?? {}),
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: dependencies.uuid });
  await server.connect(transport);
  return {
    tools,
    invoke,
    handler: async (request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (!authenticateBearer(request.headers.authorization, token)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      await transport.handleRequest(request, response);
    },
    close: async () => {
      await dependencies.providers.close();
      await volumeTools.close();
      await dependencies.events.close?.();
      await server.close();
    },
  };
}

export function createDefaultDependencies(
  providers: readonly UpstreamProvider[] = [],
  providerOptions: {
    readonly connectTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
    readonly catalogConcurrency?: number;
  } = {},
): McpApplicationDependencies {
  const runner: ProcessRunner = {
    async exec(command, options) {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      return promisify(exec)(command, options);
    },
    async execFile(file, arguments_) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      return promisify(execFile)(file, [...arguments_]);
    },
  };
  return {
    volumeAdapters: {
      async create(config) {
        switch (config.type) {
          case "local":
            return (await import("./volumes/local.js")).createLocalAdapter(config);
          case "s3":
            return (await import("./volumes/s3.js")).createS3Adapter(config);
          case "gcs":
            return (await import("./volumes/gcs.js")).createGcsAdapter(config);
          case "azure":
            return (await import("./volumes/azure.js")).createAzureAdapter(config);
          default:
            throw new VolumeAccessError(`Proxy volume type not yet implemented: ${config.type}`);
        }
      },
    },
    providers: new UpstreamRegistry([...providers], undefined, providerOptions),
    processRunner: runner,
    probeService: async (host, port) =>
      new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);
        const done = (value: boolean) => {
          socket.destroy();
          resolve(value);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.once("timeout", () => done(false));
        socket.connect(port, host);
      }),
    events: createFileMcpEventSink(),
    uuid: randomUUID,
    now: () => new Date(),
  };
}
