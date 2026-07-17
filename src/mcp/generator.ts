import { Plan } from "../core/plan.js"
import { serviceConnection } from "../core/info.js"

export function generatePlanJson(plan: Plan): string {
  const data = {
    project: plan.project,
    languages: plan.build.languageRequests.map((r) => ({
      name: r.name,
      version: r.options.version,
      packageManager: r.options.packageManager,
    })),
    services: plan.runtime.services.map((svc) => ({
      name: svc.name,
      type: svc.type,
      image: svc.image,
      ports: svc.ports.map((p) => ({ host: p.host, container: p.container })),
      connection: serviceConnection(svc) || null,
    })),
    processes: plan.runtime.processes.map((proc) => ({
      name: proc.name,
      command: proc.command,
      ports: proc.ports,
      mode: proc.mode,
      startOn: proc.startOn,
    })),
    // Endpoints are emitted verbatim. Credential values that are { env: "VAR" }
    // references stay as references here, so secrets are never written to disk;
    // the MCP server resolves them from the live container env on request.
    endpoints: plan.runtime.endpoints.map((endpoint) => ({
      name: endpoint.name,
      description: endpoint.description ?? null,
      url: endpoint.url ?? null,
      port: endpoint.port ?? null,
      credentials: endpoint.credentials ?? null,
      metadata: endpoint.metadata ?? null,
    })),
    // `environment` holds only literal values. Passthrough vars are described
    // structurally below as references, so their secret values never touch disk.
    environment: plan.runtime.environment,
    envVars: plan.runtime.envVars.map((envVar) => ({
      key: envVar.key,
      scope: envVar.scope,
      source: envVar.from ? "passthrough" : "literal",
      from: envVar.from ? envVar.from.env : null,
      required: envVar.required ?? false,
      hasDefault: envVar.default !== undefined,
    })),
  }
  return JSON.stringify(data, null, 2)
}

export function generateMcpServerContent(): string {
  return `// biodome-mcp server
import http from "node:http";
import fs from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 3001;
  let planPath = "/workspace/.biodome/plan.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) port = parseInt(args[++i], 10);
    if (args[i] === "--plan" && i + 1 < args.length) planPath = args[++i];
  }
  return { port, planPath };
}

function readPlan(path) {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function runSupervisorctl(...args) {
  try {
    const stdout = execFileSync("supervisorctl", ["-c", "/workspace/.biodome/supervisord.conf", ...args], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      code: err.status || 1,
    };
  }
}

// Managed process names are restricted to a safe charset so they can never be
// used to traverse paths or inject shell metacharacters.
function isSafeProcessName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== "..";
}

function tailFile(filePath, lines) {
  try {
    // No shell: args are passed directly to tail, so filePath is not interpreted.
    return execFileSync("tail", ["-n", String(lines), filePath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "(no log available: " + filePath + ")";
  }
}

// Credential values are either plain strings or { env: "VAR" } references.
// References are resolved from the container's live environment so secrets are
// never persisted in plan.json. A missing env var resolves to null.
function resolveSecret(value) {
  if (value && typeof value === "object" && typeof value.env === "string") {
    const resolved = process.env[value.env];
    return resolved === undefined ? null : resolved;
  }
  return value;
}

function resolveEndpoint(endpoint) {
  const credentials = endpoint.credentials
    ? Object.fromEntries(
        Object.entries(endpoint.credentials).map(([key, value]) => [key, resolveSecret(value)])
      )
    : null;
  return {
    name: endpoint.name,
    description: endpoint.description ?? null,
    url: endpoint.url ?? null,
    port: endpoint.port ?? null,
    credentials,
    metadata: endpoint.metadata ?? null,
  };
}

// Used for audit logging. Returned credential values are resolved secrets and
// should not be written to stdout; replace them with a sentinel.
function redactEndpointForLog(endpoint) {
  const credentials = endpoint.credentials
    ? Object.fromEntries(Object.keys(endpoint.credentials).map((key) => [key, "REDACTED"]))
    : null;
  return {
    ...endpoint,
    credentials,
  };
}

function checkTcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs || 2000);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

const { port, planPath } = parseArgs();
const plan = readPlan(planPath);

const mcpServer = new Server(
  { name: "biodome-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
      name: "get_process_status",
      description:
        "Get the status of all managed processes (running, stopped, etc.) from supervisorctl.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_service_health",
      description:
        "Check whether each backing service is reachable via TCP connection.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_logs",
      description:
        "Retrieve the most recent log lines for a managed process or supervisor itself.",
      inputSchema: {
        type: "object",
        properties: {
          process_name: {
            type: "string",
            description:
              'Name of the process (e.g. "biodome-mcp", "supervisord"). Defaults to "supervisord".',
          },
          lines: {
            type: "number",
            description:
              "Number of recent log lines to return (max 500). Defaults to 50.",
          },
        },
      },
    },
    {
      name: "restart_process",
      description:
        "Restart a managed process via supervisorctl. Only succeeds for daemon processes.",
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
      description:
        "Run an arbitrary command inside the dev container. All executions are logged to stdout for auditing.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
          timeout: {
            type: "number",
            description:
              "Optional timeout in seconds (max 120). Defaults to 30.",
          },
        },
        required: ["command"],
      },
    },
  ],
}));

function logCall(name, args, result) {
  console.log(
    JSON.stringify({
      type: "mcp_call",
      tool: name,
      args,
      timestamp: new Date().toISOString(),
      result,
    })
  );
}

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_sandbox_info": {
        const result = {
          content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
        };
        logCall(name, args, result);
        return result;
      }

      case "get_endpoints": {
        const endpoints = (plan.endpoints || []).map(resolveEndpoint);
        const result = {
          content: [{ type: "text", text: JSON.stringify(endpoints, null, 2) }],
        };
        // Log a redacted copy so resolved credential values don't end up in stdout.
        const redacted = {
          content: [
            {
              type: "text",
              text: JSON.stringify(endpoints.map(redactEndpointForLog), null, 2),
            },
          ],
        };
        logCall(name, args, redacted);
        return result;
      }

      case "get_process_status": {
        const { stdout, stderr } = runSupervisorctl("status");
        const result = {
          content: [
            { type: "text", text: stdout || "(no output)" },
            ...(stderr
              ? [{ type: "text", text: "stderr: " + stderr }]
              : []),
          ],
        };
        logCall(name, args, result);
        return result;
      }

      case "get_service_health": {
        const services = plan.services || [];
        const results = await Promise.all(
          services.map(async (svc) => {
            const p = svc.ports?.[0];
            const port = p?.container || p?.host;
            if (!port) return { name: svc.name, reachable: false, error: "no port defined" };
            const reachable = await checkTcpPort(svc.name, port, 2000);
            return { name: svc.name, port: port, reachable };
          })
        );
        const result = {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
        logCall(name, args, result);
        return result;
      }

      case "get_logs": {
        const processName =
          typeof args?.process_name === "string"
            ? args.process_name
            : "supervisord";
        if (!isSafeProcessName(processName)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "process_name must match [A-Za-z0-9_.-]+"
          );
        }
        const lines =
          typeof args?.lines === "number"
            ? Math.min(Math.max(1, args.lines), 500)
            : 50;
        const logPath = "/tmp/" + processName + ".log";
        const text = tailFile(logPath, lines);
        const result = { content: [{ type: "text", text }] };
        logCall(name, args, result);
        return result;
      }

      case "restart_process": {
        const processName =
          typeof args?.process_name === "string" ? args.process_name : "";
        if (!processName) {
          throw new McpError(ErrorCode.InvalidParams, "process_name is required");
        }
        if (!isSafeProcessName(processName)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "process_name must match [A-Za-z0-9_.-]+"
          );
        }
        if (processName === "biodome-mcp") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Refusing to restart the biodome-mcp server itself"
          );
        }
        const { stdout, stderr, code } = runSupervisorctl("restart", processName);
        if (code !== 0) {
          throw new McpError(ErrorCode.InternalError, stderr || "restart exited with code " + code);
        }
        const result = {
          content: [{ type: "text", text: stdout || "Restarted " + processName }],
        };
        logCall(name, args, result);
        return result;
      }

      case "exec_command": {
        const command =
          typeof args?.command === "string" ? args.command : "";
        if (!command) {
          throw new McpError(ErrorCode.InvalidParams, "command is required");
        }
        const timeout =
          typeof args?.timeout === "number"
            ? Math.min(args.timeout, 120)
            : 30;
        try {
          const stdout = execSync(command, {
            encoding: "utf-8",
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024,
            cwd: "/workspace",
            stdio: ["pipe", "pipe", "pipe"],
          });
          const result = {
            content: [
              {
                type: "text",
                text: stdout || "(completed with no output)",
              },
            ],
          };
          logCall(name, args, result);
          return result;
        } catch (err) {
          const msg = err.stdout || err.stderr || String(err);
          const result = {
            content: [{ type: "text", text: msg }],
            isError: true,
          };
          logCall(name, args, result);
          return result;
        }
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, "Unknown tool: " + name);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err)
    );
  }
});

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});

await mcpServer.connect(transport);

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  await transport.handleRequest(req, res);
});

// Bind to 0.0.0.0 inside the container. Docker forwards published-port traffic
// to the container's external interface, not loopback, so binding to 127.0.0.1
// would make the published port unreachable from the host. Host exposure is
// controlled by the compose port mapping.
httpServer.listen(port, "0.0.0.0", () => {
  console.log("biodome-mcp listening on 0.0.0.0:" + port);
});
`
}
