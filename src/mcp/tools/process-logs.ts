import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpPlan } from "../plan.js";
import { text, type ToolArguments, type ToolDefinition } from "./types.js";

export interface ProcessRunner {
  exec(
    command: string,
    options: { readonly timeout: number; readonly cwd: string },
  ): Promise<{ readonly stdout: string; readonly stderr?: string }>;
  execFile(
    file: string,
    arguments_: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}
export interface ServiceProbe {
  (host: string, port: number): Promise<boolean>;
}
const validName = (name: string) => /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== "..";
function output(error: unknown): { readonly stdout?: string; readonly stderr?: string } {
  return error instanceof Error
    ? (error as Error & { readonly stdout?: string; readonly stderr?: string })
    : {};
}

export function createProcessLogTools(
  plan: McpPlan,
  runner: ProcessRunner,
  probe: ServiceProbe,
  allowExec: boolean,
  allowProcessControl: boolean,
): readonly ToolDefinition[] {
  const status = async () => {
    try {
      const result = await runner.execFile("supervisorctl", [
        "-c",
        "/workspace/.biodome-build/supervisord.conf",
        "status",
      ]);
      return text(result.stdout || "(no output)");
    } catch (error) {
      const result = output(error);
      return text(
        result.stderr
          ? `${result.stdout || "(no output)"}\nstderr: ${result.stderr}`
          : result.stdout || "(no output)",
      );
    }
  };
  return [
    {
      name: "get_process_status",
      description:
        "Get the status of all managed processes (running, stopped, etc.) from supervisorctl.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => status(),
    },
    {
      name: "get_service_health",
      description: "Check whether each backing service is reachable via TCP connection.",
      inputSchema: { type: "object", properties: {} },
      handler: async () =>
        text(
          JSON.stringify(
            await Promise.all(
              plan.services.map(async (service) => {
                const port = service.ports[0]?.container ?? service.ports[0]?.host;
                return port === undefined
                  ? { name: service.name, reachable: false, error: "no port defined" }
                  : { name: service.name, port, reachable: await probe(service.name, port) };
              }),
            ),
            null,
            2,
          ),
        ),
    },
    {
      name: "get_logs",
      description: "Retrieve the most recent log lines for a managed process or supervisor itself.",
      inputSchema: {
        type: "object",
        properties: { process_name: { type: "string" }, lines: { type: "number" } },
      },
      handler: async (args) => {
        const name = typeof args.process_name === "string" ? args.process_name : "supervisord";
        if (!validName(name))
          throw new McpError(ErrorCode.InvalidParams, "process_name must match [A-Za-z0-9_.-]+");
        const lines = typeof args.lines === "number" ? Math.min(Math.max(1, args.lines), 500) : 50;
        const file = `/tmp/${name}.log`;
        try {
          return text((await runner.execFile("tail", ["-n", String(lines), file])).stdout);
        } catch {
          return text(`(no log available: ${file})`);
        }
      },
    },
    ...(allowProcessControl
      ? [
          {
            name: "restart_process",
            description:
              "Restart a managed process via supervisorctl. Only succeeds for daemon processes.",
            inputSchema: {
              type: "object",
              properties: { process_name: { type: "string" } },
              required: ["process_name"],
            },
            handler: async (args: ToolArguments) => {
              const name = typeof args.process_name === "string" ? args.process_name : "";
              if (!name) throw new McpError(ErrorCode.InvalidParams, "process_name is required");
              if (!validName(name))
                throw new McpError(
                  ErrorCode.InvalidParams,
                  "process_name must match [A-Za-z0-9_.-]+",
                );
              if (name === "biodome-mcp")
                throw new McpError(
                  ErrorCode.InvalidParams,
                  "Refusing to restart the biodome-mcp server itself",
                );
              try {
                const output = await runner.execFile("supervisorctl", [
                  "-c",
                  "/workspace/.biodome-build/supervisord.conf",
                  "restart",
                  name,
                ]);
                return text(output.stdout || `Restarted ${name}`);
              } catch (error) {
                throw new McpError(
                  ErrorCode.InternalError,
                  output(error).stderr || "restart exited with code 1",
                );
              }
            },
          },
        ]
      : []),
    ...(allowExec
      ? [
          {
            name: "exec_command",
            description:
              "Run an arbitrary command inside the dev container. All executions are logged to stdout for auditing.",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" }, timeout: { type: "number" } },
              required: ["command"],
            },
            handler: async (args: ToolArguments) => {
              const command = typeof args.command === "string" ? args.command : "";
              if (!command) throw new McpError(ErrorCode.InvalidParams, "command is required");
              try {
                const result = await runner.exec(command, {
                  timeout:
                    (typeof args.timeout === "number" ? Math.min(args.timeout, 120) : 30) * 1000,
                  cwd: "/workspace",
                });
                return text(result.stdout || "(completed with no output)");
              } catch (error) {
                const result = output(error);
                return text(result.stdout || result.stderr || String(error), true);
              }
            },
          },
        ]
      : []),
  ];
}
