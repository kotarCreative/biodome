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
import { createProcessRunner, type ProcessRunner } from "./command-runner.js";
import { redactString } from "../core/redaction.js";
import type { McpPlan } from "./plan.js";
import { resolvePlanSecret } from "./plan.js";
import { filterProviderTools } from "./provider-tools.js";
import {
  UpstreamRegistry,
  type CatalogEntry,
  type ProviderError,
  type UpstreamProvider,
} from "./upstream.js";
import type { VolumeConfig } from "./volumes/adapter.js";
import { VolumeAccessError } from "./volumes/adapter.js";
import { createInfoProviderTools } from "./tools/info-provider.js";
import { createProcessLogTools, type ServiceProbe } from "./tools/process-logs.js";
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
  /** Override for tests; defaults to 10 MiB. */
  readonly maxRequestBodyBytes?: number;
}
export interface McpApplication {
  readonly handler: http.RequestListener;
  readonly tools: readonly ToolDefinition[];
  invoke(name: string, arguments_?: ToolArguments): Promise<TextResult>;
  close(): Promise<void>;
}

const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

export interface McpApplicationOptions {
  /** Exact Host header values permitted when DNS-rebinding protection is enabled. */
  readonly allowedHosts?: readonly string[];
}

function payloadTooLarge(
  response: http.ServerResponse,
  request: http.IncomingMessage,
  maxBytes: number,
): void {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: ErrorCode.InvalidRequest,
      message: `Request body exceeds the ${maxBytes} byte limit`,
    },
    id: null,
  });
  if (response.headersSent) {
    request.destroy();
    return;
  }
  response.writeHead(413, { "Content-Type": "application/json" });
  response.end(body, () => request.destroy());
}

// Read the full request body under a hard byte cap so oversized payloads are
// rejected before transport dispatch, regardless of framing (content-length
// or chunked). The parsed body is then handed to the transport explicitly.
function readBodyWithCap(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly body: string } | { readonly ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (
      result: { readonly ok: true; readonly body: string } | { readonly ok: false },
    ) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      request.removeAllListeners("data");
      request.removeAllListeners("end");
      request.resume();
      payloadTooLarge(response, request, maxBytes);
      finish({ ok: false });
    });
    request.once("end", () =>
      finish({ ok: true, body: Buffer.concat(chunks, received).toString("utf8") }),
    );
    request.once("error", () => {
      request.destroy();
      finish({ ok: false });
    });
  });
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
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
  options: McpApplicationOptions = {},
): Promise<McpApplication> {
  const token = resolvePlanSecret(plan.mcp.token, environment);
  if (plan.mcp.enabled === true && (!token || token.length === 0)) {
    throw new Error(
      plan.mcp.token && "env" in plan.mcp.token
        ? `MCP is enabled but token environment variable ${plan.mcp.token.env} is missing or empty`
        : "MCP is enabled but no environment-backed token is configured",
    );
  }
  if (token && /^\$\{.*\}$/.test(token)) {
    throw new Error(
      plan.mcp.token && "env" in plan.mcp.token
        ? `MCP token environment variable ${plan.mcp.token.env} contains an unresolved placeholder`
        : "MCP token contains an unresolved placeholder",
    );
  }
  // Schema validation bounds these; the clamps defend against plans that bypass decoding.
  const maxReadBytes = positiveIntOr(plan.mcp.maxReadBytes, 1048576);
  const maxWriteBytes = positiveIntOr(plan.mcp.maxWriteBytes, 2097152);
  const maxListEntries = positiveIntOr(plan.mcp.maxListEntries, 100);
  const skipped = buildUpstreams(plan, environment).skipped;
  const volumeTools = createVolumeTools(plan.volumes.map(asVolume), dependencies.volumeAdapters, {
    read: maxReadBytes,
    write: maxWriteBytes,
    list: maxListEntries,
  });
  const tools = filterProviderTools(
    [
      ...createInfoProviderTools(plan, dependencies.providers, maxListEntries, skipped),
      ...createProcessLogTools(
        plan,
        dependencies.processRunner,
        dependencies.probeService,
        plan.mcp.allowExec === true,
        plan.mcp.allowProcessControl === true,
        plan.mcp.commandTimeoutMs ?? 30000,
        (type, data) => dependencies.events.write(type, data),
      ),
      ...volumeTools.tools,
    ],
    plan.providers,
  );
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
      // Never forward raw failure text to clients: log a redacted detail
      // server-side and return a generic internal error.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[biodome-mcp] tool ${name} failed: ${redactString(detail)}`);
      throw new McpError(ErrorCode.InternalError, `Tool "${name}" failed`);
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
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: dependencies.uuid,
    ...(options.allowedHosts && options.allowedHosts.length > 0
      ? { enableDnsRebindingProtection: true, allowedHosts: [...options.allowedHosts] }
      : {}),
  });
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
      if (request.method !== "POST") {
        await transport.handleRequest(request, response);
        return;
      }
      const maxRequestBodyBytes =
        dependencies.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
      const contentLength = Number(request.headers["content-length"]);
      if (Number.isInteger(contentLength) && contentLength > maxRequestBodyBytes) {
        payloadTooLarge(response, request, maxRequestBodyBytes);
        return;
      }
      const read = await readBodyWithCap(request, response, maxRequestBodyBytes);
      if (!read.ok) return;
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(read.body);
      } catch {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: ErrorCode.ParseError, message: "Parse error: Invalid JSON" },
            id: null,
          }),
        );
        return;
      }
      await transport.handleRequest(request, response, parsedBody);
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
  commandLimits: {
    readonly timeoutMs?: number;
    readonly stdoutMaxBytes?: number;
    readonly stderrMaxBytes?: number;
  } = {},
): McpApplicationDependencies {
  const runner: ProcessRunner = createProcessRunner({
    timeoutMs: commandLimits.timeoutMs ?? 30000,
    stdoutMaxBytes: commandLimits.stdoutMaxBytes ?? 1048576,
    stderrMaxBytes: commandLimits.stderrMaxBytes ?? 1048576,
  });
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
