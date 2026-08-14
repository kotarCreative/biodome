import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpPlan } from "../plan.js";
import { CommandExecutionError, type ProcessRunner } from "../command-runner.js";
import { text, type ToolArguments, type ToolDefinition } from "./types.js";

export type { ProcessRunner } from "../command-runner.js";
export interface ServiceProbe {
  (host: string, port: number): Promise<boolean>;
}
const validName = (name: string) => /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== "..";
export function createProcessLogTools(
  plan: McpPlan,
  runner: ProcessRunner,
  probe: ServiceProbe,
  allowExec: boolean,
  allowProcessControl: boolean,
  commandTimeoutMs: number,
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
      if (error instanceof CommandExecutionError) {
        return text(
          error.stderr
            ? `${error.stdout || "(no output)"}\nstderr: ${error.stderr}`
            : error.stdout || "(no output)",
        );
      }
      return text(error instanceof Error ? error.message : "Command failed");
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
        } catch (error) {
          const details =
            error instanceof CommandExecutionError
              ? error.stderr || error.stdout || error.message
              : error instanceof Error
                ? error.message
                : "Command failed";
          return text(`(no log available: ${file}) - ${details}`);
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
                  error instanceof CommandExecutionError
                    ? error.stderr || error.stdout || error.message
                    : error instanceof Error
                      ? error.message
                      : "restart exited with code 1",
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
                const userTimeoutMs =
                  typeof args.timeout === "number" && Number.isFinite(args.timeout)
                    ? Math.min(Math.max(1, args.timeout * 1000), commandTimeoutMs)
                    : commandTimeoutMs;
                const result = await runner.exec(command, {
                  timeoutMs: userTimeoutMs,
                  cwd: "/workspace",
                });
                return text(result.stdout || "(completed with no output)");
              } catch (error) {
                return text(
                  error instanceof CommandExecutionError
                    ? error.stdout || error.stderr || error.message
                    : error instanceof Error
                      ? error.message
                      : "Command failed",
                  true,
                );
              }
            },
          },
        ]
      : []),
  ];
}
