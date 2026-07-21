import http from "node:http"
import fs from "node:fs"
import { execSync, execFileSync } from "node:child_process"
import net from "node:net"
import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import {
  VolumeConfig,
  VolumeAdapter,
  FileInfo,
  matchesAllowedPath,
  VolumeAccessError,
} from "./volumes/adapter.js"
import { filterProviderTools } from "./provider-tools.js"
import { UpstreamRegistry, type UpstreamProvider } from "./upstream.js"

async function createVolumeAdapter(config: VolumeConfig): Promise<VolumeAdapter> {
  switch (config.type) {
    case "local": {
      const { createLocalAdapter } = await import("./volumes/local.js")
      return createLocalAdapter(config)
    }
    case "s3": {
      const { createS3Adapter } = await import("./volumes/s3.js")
      return createS3Adapter(config)
    }
    case "gcs": {
      const { createGcsAdapter } = await import("./volumes/gcs.js")
      return createGcsAdapter(config)
    }
    case "azure": {
      const { createAzureAdapter } = await import("./volumes/azure.js")
      return createAzureAdapter(config)
    }
    default:
      throw new VolumeAccessError(`Proxy volume type not yet implemented: ${config.type}`)
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  let port = 3001
  let planPath = "/workspace/.biodome-build/plan.json"
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) port = parseInt(args[++i], 10)
    if (args[i] === "--plan" && i + 1 < args.length) planPath = args[++i]
  }
  return { port, planPath }
}

function readPlan(path: string) {
  return JSON.parse(fs.readFileSync(path, "utf-8"))
}

function runSupervisorctl(...args: string[]) {
  try {
    const stdout = execFileSync("supervisorctl", ["-c", "/workspace/.biodome-build/supervisord.conf", ...args], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { stdout, stderr: "", code: 0 }
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      code: err.status || 1,
    }
  }
}

function isSafeProcessName(name: string) {
  return typeof name === "string" && /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== ".."
}

function tailFile(filePath: string, lines: number) {
  try {
    return execFileSync("tail", ["-n", String(lines), filePath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch {
    return "(no log available: " + filePath + ")"
  }
}

function resolveSecret(value: unknown): string | null {
  if (value && typeof value === "object" && typeof (value as { env?: string }).env === "string") {
    const resolved = process.env[(value as { env: string }).env]
    return resolved === undefined ? null : resolved
  }
  if (typeof value === "string") return value
  return null
}

function resolveEndpoint(endpoint: any) {
  const credentials = endpoint.credentials
    ? Object.fromEntries(
        Object.entries(endpoint.credentials).map(([key, value]) => [key, resolveSecret(value)])
      )
    : null
  return {
    name: endpoint.name,
    description: endpoint.description ?? null,
    url: endpoint.url ?? null,
    port: endpoint.port ?? null,
    credentials,
    metadata: endpoint.metadata ?? null,
  }
}

function redactEndpointForLog(endpoint: any) {
  const credentials = endpoint.credentials
    ? Object.fromEntries(Object.keys(endpoint.credentials).map((key) => [key, "REDACTED"]))
    : null
  return { ...endpoint, credentials }
}

function checkTcpPort(host: string, port: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs || 2000)
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      socket.destroy()
      resolve(false)
    })
    socket.on("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, host)
  })
}

function parseVolumePath(path: string): { volume: string; subPath: string } | null {
  const match = path.match(/^([^/:]+):\/?(.*)$/)
  if (!match) return null
  return { volume: match[1], subPath: match[2] }
}

function formatFileInfo(file: FileInfo): string {
  return `${file.isDirectory ? "d" : "-"} ${file.path}${file.size !== undefined ? ` (${file.size} bytes)` : ""}`
}

const { port, planPath } = parseArgs()
const plan = readPlan(planPath)

const providers: any[] = plan.providers || []

function toUpstream(p: any): UpstreamProvider | null {
  if (!p.mcpUrl) return null
  const credKey = p.authCredential || "token"
  const token = resolveSecret(p.credentials?.[credKey])
  if (!token) return null
  return {
    name: p.name,
    type: p.type,
    mcpUrl: p.mcpUrl,
    authHeader: p.authHeader || "Authorization",
    authScheme: p.authScheme || "Bearer ",
    token,
  }
}

function buildUpstreamList(providers: any[]): { upstream: UpstreamProvider[]; skipped: string[] } {
  const upstream: UpstreamProvider[] = []
  const skipped: string[] = []
  for (const p of providers) {
    const converted = toUpstream(p)
    if (converted) {
      upstream.push(converted)
    } else if (p.mcpUrl) {
      skipped.push(`${p.name}: credential ${p.authCredential || "token"} not resolvable`)
    } else {
      skipped.push(`${p.name}: no mcpUrl configured`)
    }
  }
  return { upstream, skipped }
}

const { upstream: upstreamProviders, skipped: skippedProviders } = buildUpstreamList(providers)
const registry = new UpstreamRegistry(upstreamProviders)

function resolveProvider(provider: any) {
  const credentials = provider.credentials
    ? Object.fromEntries(
        Object.entries(provider.credentials).map(([key, value]) => [key, resolveSecret(value)])
      )
    : null
  return {
    name: provider.name,
    type: provider.type,
    url: provider.url ?? null,
    project: provider.project ?? null,
    credentials,
    metadata: provider.metadata ?? null,
  }
}

function redactProviderForLog(provider: any) {
  const credentials = provider.credentials
    ? Object.fromEntries(Object.keys(provider.credentials).map((key) => [key, "REDACTED"]))
    : null
  return { ...provider, credentials }
}


const mcpServer = new Server(
  { name: "biodome-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

const proxyVolumes: VolumeConfig[] = (plan.volumes || []).filter((v: VolumeConfig) => v.proxy)

function findVolume(name: string): VolumeConfig | undefined {
  return proxyVolumes.find((v) => v.name === name)
}

function assertWriteAllowed(volume: VolumeConfig, subPath: string) {
  if (volume.readOnly) {
    throw new VolumeAccessError(`Volume ${volume.name} is read-only`)
  }
  if (!matchesAllowedPath(subPath, volume.allowedPaths)) {
    throw new VolumeAccessError(`Path ${subPath} is not allowed on volume ${volume.name}`)
  }
}

function assertReadAllowed(volume: VolumeConfig, subPath: string) {
  if (!matchesAllowedPath(subPath, volume.allowedPaths)) {
    throw new VolumeAccessError(`Path ${subPath} is not allowed on volume ${volume.name}`)
  }
}

function logCall(name: string, args: any, result: any) {
  console.log(
    JSON.stringify({
      type: "mcp_call",
      tool: name,
      args,
      timestamp: new Date().toISOString(),
      result,
    })
  )
}

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  const allTools = [
    {
      name: "get_sandbox_info",
      description:
        "Get a description of the current sandbox setup: project, languages, services, processes, ports, and connection strings.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_endpoints",
      description:
        "List the feature-declared endpoints (custom APIs and services) with their URLs, ports, credentials, and metadata. Credential values that reference an environment variable are resolved from the live container environment.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_providers",
      description:
        "List the feature-declared external providers (e.g. Jira, GitHub, Slack) with their type, URL, project, credentials, and metadata. Credential values that reference an environment variable are resolved from the live container environment.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "provider_search",
      description:
        "Search across all connected provider tools (Jira, Linear, Sentry, ...). " +
        "Returns matching tool names (formatted 'provider.tool'), descriptions, and their provider. " +
        "Use this first to discover which tool to call, then provider_describe for its input schema.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to match against tool names and descriptions." },
          provider: { type: "string", description: "Optional: restrict to one provider by name." },
          limit: { type: "number", description: "Max results (default 20)." },
        },
      },
    },
    {
      name: "provider_describe",
      description:
        "Get the full input schema and description for one provider tool. " +
        "Pass the qualified name from provider_search, e.g. 'linear.create_issue'.",
      inputSchema: {
        type: "object",
        properties: { tool: { type: "string", description: "Qualified tool name 'provider.tool'." } },
        required: ["tool"],
      },
    },
    {
      name: "provider_execute",
      description:
        "Execute one provider tool by its qualified name with arguments. " +
        "Credentials are attached by the server; you never need a token.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Qualified tool name 'provider.tool'." },
          arguments: { type: "object", description: "Arguments object matching the tool's input schema." },
        },
        required: ["tool"],
      },
    },
    {
      name: "get_process_status",
      description: "Get the status of all managed processes (running, stopped, etc.) from supervisorctl.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_service_health",
      description: "Check whether each backing service is reachable via TCP connection.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_logs",
      description: "Retrieve the most recent log lines for a managed process or supervisor itself.",
      inputSchema: {
        type: "object",
        properties: {
          process_name: {
            type: "string",
            description: 'Name of the process (e.g. "biodome-mcp", "supervisord"). Defaults to "supervisord".',
          },
          lines: {
            type: "number",
            description: "Number of recent log lines to return (max 500). Defaults to 50.",
          },
        },
      },
    },
    {
      name: "restart_process",
      description: "Restart a managed process via supervisorctl. Only succeeds for daemon processes.",
      inputSchema: {
        type: "object",
        properties: {
          process_name: {
            type: "string",
            description: "Name of the process to restart.",
          },
        },
        required: ["process_name"],
      },
    },
    {
      name: "exec_command",
      description: "Run an arbitrary command inside the dev container. All executions are logged to stdout for auditing.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
          timeout: {
            type: "number",
            description: "Optional timeout in seconds (max 120). Defaults to 30.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "list_volumes",
      description: "List proxy volumes exposed by the biodome MCP server. These volumes are not mounted in the dev container; access them through the file tools.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_files",
      description: "List files in a proxy volume path. Paths are formatted as 'volume-name:prefix/'.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Volume-qualified path, e.g. 's3-data:reports/'.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "read_file",
      description: "Read a file from a proxy volume. Returns base64-encoded content. Paths are formatted as 'volume-name:path/to/file'.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Volume-qualified path, e.g. 's3-data:reports/file.pdf'.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write a file to a proxy volume. Content must be base64-encoded. Paths are formatted as 'volume-name:path/to/file'.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Volume-qualified path, e.g. 's3-data:reports/file.pdf'.",
          },
          content: {
            type: "string",
            description: "Base64-encoded file content.",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "stat_file",
      description: "Get metadata for a file in a proxy volume. Paths are formatted as 'volume-name:path/to/file'.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Volume-qualified path, e.g. 's3-data:reports/file.pdf'.",
          },
        },
        required: ["path"],
      },
    },
  ]
  const tools = filterProviderTools(allTools, providers)
  return { tools }
})

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case "get_sandbox_info": {
        const result = {
          content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
        }
        logCall(name, args, result)
        return result
      }

      case "get_endpoints": {
        const endpoints = (plan.endpoints || []).map(resolveEndpoint)
        const result = {
          content: [{ type: "text", text: JSON.stringify(endpoints, null, 2) }],
        }
        const redacted = {
          content: [{ type: "text", text: JSON.stringify(endpoints.map(redactEndpointForLog), null, 2) }],
        }
        logCall(name, args, redacted)
        return result
      }

      case "get_providers": {
        const resolved = providers.map(resolveProvider)
        const result = {
          content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }],
        }
        const redacted = {
          content: [{ type: "text", text: JSON.stringify(resolved.map(redactProviderForLog), null, 2) }],
        }
        logCall(name, args, redacted)
        return result
      }

      case "provider_search": {
        const query = typeof args?.query === "string" ? args.query.toLowerCase() : ""
        const providerFilter = typeof args?.provider === "string" ? args.provider : undefined
        const limit = typeof args?.limit === "number" ? Math.min(Math.max(1, args.limit), 100) : 20
        const catalog = await registry.listCatalog()
        let matches = catalog
        if (providerFilter) matches = matches.filter((e) => e.provider === providerFilter)
        if (query) {
          matches = matches.filter((e) =>
            e.qualified.toLowerCase().includes(query) ||
            (e.description || "").toLowerCase().includes(query)
          )
        }
        const results = matches.slice(0, limit).map((e) => ({
          tool: e.qualified, provider: e.provider, description: e.description,
        }))
        const result = {
          content: [{
            type: "text",
            text: JSON.stringify({
              results,
              errors: registry.getErrors(),
              skipped: skippedProviders,
            }, null, 2),
          }],
        }
        logCall(name, args, result)
        return result
      }

      case "provider_describe": {
        const tool = typeof args?.tool === "string" ? args.tool : ""
        if (!tool) throw new McpError(ErrorCode.InvalidParams, "tool is required")
        const entry = await registry.describe(tool)
        const result = { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] }
        logCall(name, args, result)
        return result
      }

      case "provider_execute": {
        const tool = typeof args?.tool === "string" ? args.tool : ""
        if (!tool) throw new McpError(ErrorCode.InvalidParams, "tool is required")
        const toolArgs = (args?.arguments && typeof args.arguments === "object") ? args.arguments : {}
        const data = await registry.call(tool, toolArgs)
        const result = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
        const text = result.content[0]?.text ?? ""
        const redacted = { content: [{ type: "text", text: `<result ${Buffer.byteLength(text, "utf8")} bytes>` }] }
        logCall(name, args, redacted)
        return result
      }

      case "get_process_status": {
        const { stdout, stderr } = runSupervisorctl("status")
        const result = {
          content: [
            { type: "text", text: stdout || "(no output)" },
            ...(stderr ? [{ type: "text", text: "stderr: " + stderr }] : []),
          ],
        }
        logCall(name, args, result)
        return result
      }

      case "get_service_health": {
        const services = plan.services || []
        const results = await Promise.all(
          services.map(async (svc: any) => {
            const p = svc.ports?.[0]
            const port = p?.container || p?.host
            if (!port) return { name: svc.name, reachable: false, error: "no port defined" }
            const reachable = await checkTcpPort(svc.name, port, 2000)
            return { name: svc.name, port: port, reachable }
          })
        )
        const result = {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        }
        logCall(name, args, result)
        return result
      }

      case "get_logs": {
        const processName = typeof args?.process_name === "string" ? args.process_name : "supervisord"
        if (!isSafeProcessName(processName)) {
          throw new McpError(ErrorCode.InvalidParams, "process_name must match [A-Za-z0-9_.-]+")
        }
        const lines = typeof args?.lines === "number" ? Math.min(Math.max(1, args.lines), 500) : 50
        const logPath = "/tmp/" + processName + ".log"
        const text = tailFile(logPath, lines)
        const result = { content: [{ type: "text", text }] }
        logCall(name, args, result)
        return result
      }

      case "restart_process": {
        const processName = typeof args?.process_name === "string" ? args.process_name : ""
        if (!processName) {
          throw new McpError(ErrorCode.InvalidParams, "process_name is required")
        }
        if (!isSafeProcessName(processName)) {
          throw new McpError(ErrorCode.InvalidParams, "process_name must match [A-Za-z0-9_.-]+")
        }
        if (processName === "biodome-mcp") {
          throw new McpError(ErrorCode.InvalidParams, "Refusing to restart the biodome-mcp server itself")
        }
        const { stdout, stderr, code } = runSupervisorctl("restart", processName)
        if (code !== 0) {
          throw new McpError(ErrorCode.InternalError, stderr || "restart exited with code " + code)
        }
        const result = {
          content: [{ type: "text", text: stdout || "Restarted " + processName }],
        }
        logCall(name, args, result)
        return result
      }

      case "exec_command": {
        const command = typeof args?.command === "string" ? args.command : ""
        if (!command) {
          throw new McpError(ErrorCode.InvalidParams, "command is required")
        }
        const timeout = typeof args?.timeout === "number" ? Math.min(args.timeout, 120) : 30
        try {
          const stdout = execSync(command, {
            encoding: "utf-8",
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024,
            cwd: "/workspace",
            stdio: ["pipe", "pipe", "pipe"],
          })
          const result = {
            content: [{ type: "text", text: stdout || "(completed with no output)" }],
          }
          logCall(name, args, result)
          return result
        } catch (err: any) {
          const msg = err.stdout || err.stderr || String(err)
          const result = {
            content: [{ type: "text", text: msg }],
            isError: true,
          }
          logCall(name, args, result)
          return result
        }
      }

      case "list_volumes": {
        const result = {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                proxyVolumes.map((v) => ({
                  name: v.name,
                  type: v.type,
                  target: v.target,
                  readOnly: v.readOnly ?? false,
                  allowedPaths: v.allowedPaths ?? [],
                })),
                null,
                2
              ),
            },
          ],
        }
        logCall(name, args, result)
        return result
      }

      case "list_files": {
        const path = typeof args?.path === "string" ? args.path : ""
        const parsed = parseVolumePath(path)
        if (!parsed) {
          throw new McpError(ErrorCode.InvalidParams, "path must be formatted as 'volume-name:prefix/'")
        }
        const volume = findVolume(parsed.volume)
        if (!volume) {
          throw new McpError(ErrorCode.InvalidParams, "Unknown proxy volume: " + parsed.volume)
        }
        assertReadAllowed(volume, parsed.subPath)
        const adapter = await createVolumeAdapter(volume)
        const files = await adapter.list(parsed.subPath)
        const result = {
          content: [{ type: "text", text: files.map(formatFileInfo).join("\n") }],
        }
        logCall(name, args, result)
        return result
      }

      case "read_file": {
        const path = typeof args?.path === "string" ? args.path : ""
        const parsed = parseVolumePath(path)
        if (!parsed) {
          throw new McpError(ErrorCode.InvalidParams, "path must be formatted as 'volume-name:path/to/file'")
        }
        const volume = findVolume(parsed.volume)
        if (!volume) {
          throw new McpError(ErrorCode.InvalidParams, "Unknown proxy volume: " + parsed.volume)
        }
        assertReadAllowed(volume, parsed.subPath)
        const adapter = await createVolumeAdapter(volume)
        const buffer = await adapter.read(parsed.subPath)
        const result = {
          content: [{ type: "text", text: buffer.toString("base64") }],
        }
        logCall(name, args, { ...result, content: [{ type: "text", text: "<base64 redacted>" }] })
        return result
      }

      case "write_file": {
        const path = typeof args?.path === "string" ? args.path : ""
        const content = typeof args?.content === "string" ? args.content : ""
        const parsed = parseVolumePath(path)
        if (!parsed) {
          throw new McpError(ErrorCode.InvalidParams, "path must be formatted as 'volume-name:path/to/file'")
        }
        const volume = findVolume(parsed.volume)
        if (!volume) {
          throw new McpError(ErrorCode.InvalidParams, "Unknown proxy volume: " + parsed.volume)
        }
        assertWriteAllowed(volume, parsed.subPath)
        const adapter = await createVolumeAdapter(volume)
        const buffer = Buffer.from(content, "base64")
        await adapter.write(parsed.subPath, buffer)
        const result = {
          content: [{ type: "text", text: `Wrote ${buffer.length} bytes to ${path}` }],
        }
        logCall(name, args, result)
        return result
      }

      case "stat_file": {
        const path = typeof args?.path === "string" ? args.path : ""
        const parsed = parseVolumePath(path)
        if (!parsed) {
          throw new McpError(ErrorCode.InvalidParams, "path must be formatted as 'volume-name:path/to/file'")
        }
        const volume = findVolume(parsed.volume)
        if (!volume) {
          throw new McpError(ErrorCode.InvalidParams, "Unknown proxy volume: " + parsed.volume)
        }
        assertReadAllowed(volume, parsed.subPath)
        const adapter = await createVolumeAdapter(volume)
        const info = await adapter.stat(parsed.subPath)
        const result = {
          content: [{ type: "text", text: formatFileInfo(info) }],
        }
        logCall(name, args, result)
        return result
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, "Unknown tool: " + name)
    }
  } catch (err) {
    if (err instanceof McpError) throw err
    if (err instanceof VolumeAccessError) {
      throw new McpError(ErrorCode.InvalidParams, err.message)
    }
    throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err))
  }
})

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
})

await mcpServer.connect(transport)

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok" }))
    return
  }
  await transport.handleRequest(req, res)
})

httpServer.listen(port, "0.0.0.0", () => {
  console.log("biodome-mcp listening on 0.0.0.0:" + port)
})
