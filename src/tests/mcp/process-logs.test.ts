import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandExecutionError } from "../../mcp/command-runner.js";
import { decodeMcpPlan, type McpPlan } from "../../mcp/plan.js";
import { createProcessLogTools } from "../../mcp/tools/process-logs.js";

const LOG_DIR_ENV = "BIODOME_LOG_DIR";
const previousLogDir = process.env[LOG_DIR_ENV];

afterEach(() => {
  if (previousLogDir === undefined) delete process.env[LOG_DIR_ENV];
  else process.env[LOG_DIR_ENV] = previousLogDir;
});

function plan(): McpPlan {
  return decodeMcpPlan({
    project: "test",
    languages: [],
    services: [],
    processes: [],
    endpoints: [],
    providers: [],
    environment: {},
    envVars: [],
    repos: [],
    volumes: [],
    mcp: { enabled: true },
  });
}

function tools() {
  const runner = {
    exec: vi.fn(async (_command: string, _options: unknown) => ({ stdout: "", stderr: "" })),
    execFile: vi.fn(async (_file: string, _arguments_: readonly string[]) => ({
      stdout: "log line",
      stderr: "",
    })),
  };
  const definitions = createProcessLogTools(
    plan(),
    runner,
    async () => true,
    false,
    false,
    30000,
    async () => {},
  );
  const getLogs = definitions.find((tool) => tool.name === "get_logs");
  if (!getLogs) throw new Error("get_logs tool is not registered");
  return { runner, getLogs };
}

function resultText(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return result.content[0]?.text ?? "";
}

describe("get_logs path resolution", () => {
  it("tails logs inside BIODOME_LOG_DIR when the supervisord environment provides it", async () => {
    process.env[LOG_DIR_ENV] = "/workspace/.biodome-build/targets/dev/logs";
    const { runner, getLogs } = tools();

    const result = await getLogs.handler({ process_name: "worker", lines: 10 });

    expect(runner.execFile).toHaveBeenCalledWith("tail", [
      "-n",
      "10",
      "/workspace/.biodome-build/targets/dev/logs/worker.log",
    ]);
    expect(resultText(result)).toBe("log line");
  });

  it("falls back to the default runtime log dir when the variable is unset", async () => {
    delete process.env[LOG_DIR_ENV];
    const { runner, getLogs } = tools();

    await getLogs.handler({ process_name: "worker" });

    expect(runner.execFile).toHaveBeenCalledWith("tail", [
      "-n",
      "50",
      "/workspace/.biodome-build/logs/worker.log",
    ]);
  });

  it("resolves the supervisord pseudo-process next to program logs", async () => {
    process.env[LOG_DIR_ENV] = "/workspace/.biodome-build/targets/dev/logs";
    const { runner, getLogs } = tools();

    await getLogs.handler({});

    expect(runner.execFile).toHaveBeenCalledWith("tail", [
      "-n",
      "50",
      "/workspace/.biodome-build/targets/dev/logs/supervisord.log",
    ]);
  });

  it("never resolves log paths under world-writable /tmp", async () => {
    process.env[LOG_DIR_ENV] = "/workspace/.biodome-build/targets/dev/logs";
    const injected = tools();
    await injected.getLogs.handler({ process_name: "worker" });
    delete process.env[LOG_DIR_ENV];
    const fallback = tools();
    await fallback.getLogs.handler({ process_name: "supervisord" });

    for (const { runner } of [injected, fallback]) {
      for (const [, arguments_] of runner.execFile.mock.calls) {
        expect(arguments_[2]).not.toMatch(/^\/tmp\//);
      }
    }
  });

  it("clamps the requested line count to the supported range", async () => {
    delete process.env[LOG_DIR_ENV];
    const { runner, getLogs } = tools();

    await getLogs.handler({ process_name: "worker", lines: 1000 });
    await getLogs.handler({ process_name: "worker", lines: 0 });

    expect(runner.execFile).toHaveBeenNthCalledWith(1, "tail", [
      "-n",
      "500",
      "/workspace/.biodome-build/logs/worker.log",
    ]);
    expect(runner.execFile).toHaveBeenNthCalledWith(2, "tail", [
      "-n",
      "1",
      "/workspace/.biodome-build/logs/worker.log",
    ]);
  });

  it("rejects process names that could escape the log directory", async () => {
    const { getLogs } = tools();

    await expect(getLogs.handler({ process_name: "../secrets" })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("reports the resolved path when the log file cannot be read", async () => {
    delete process.env[LOG_DIR_ENV];
    const { runner, getLogs } = tools();
    runner.execFile.mockRejectedValueOnce(
      new CommandExecutionError("exit", "", "tail: cannot open", 1),
    );

    const result = await getLogs.handler({ process_name: "worker" });

    expect(resultText(result)).toContain(
      "(no log available: /workspace/.biodome-build/logs/worker.log)",
    );
    expect(resultText(result)).toContain("tail: cannot open");
  });
});
