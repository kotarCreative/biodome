import { describe, expect, it } from "vitest";
import { CommandExecutionError, createProcessRunner } from "../../mcp/command-runner.js";

const node = process.execPath;

describe("MCP command runner", () => {
  it("collects stdout and stderr independently for argv execution", async () => {
    const runner = createProcessRunner({
      timeoutMs: 1000,
      stdoutMaxBytes: 32,
      stderrMaxBytes: 32,
    });

    await expect(
      runner.execFile(node, ["-e", 'process.stdout.write("out"); process.stderr.write("err")']),
    ).resolves.toEqual({ stdout: "out", stderr: "err" });
  });

  it("terminates commands that exceed the stdout limit", async () => {
    const runner = createProcessRunner({
      timeoutMs: 1000,
      stdoutMaxBytes: 16,
      stderrMaxBytes: 16,
    });

    await expect(
      runner.execFile(node, ["-e", 'process.stdout.write("x".repeat(17))']),
    ).rejects.toMatchObject({
      reason: "stdout_limit",
      message: "Command stdout exceeded its byte limit",
    } satisfies Partial<CommandExecutionError>);
  });

  it("terminates commands that exceed the stderr limit", async () => {
    const runner = createProcessRunner({
      timeoutMs: 1000,
      stdoutMaxBytes: 16,
      stderrMaxBytes: 16,
    });

    await expect(
      runner.execFile(node, ["-e", 'process.stderr.write("x".repeat(17))']),
    ).rejects.toMatchObject({
      reason: "stderr_limit",
      message: "Command stderr exceeded its byte limit",
    } satisfies Partial<CommandExecutionError>);
  });

  it("runs commands through a shell", async () => {
    const runner = createProcessRunner({
      timeoutMs: 1000,
      stdoutMaxBytes: 32,
      stderrMaxBytes: 32,
    });

    await expect(runner.exec(`${node} -e "process.stdout.write('shell')"`)).resolves.toEqual({
      stdout: "shell",
      stderr: "",
    });
  });

  it("falls back to the configured timeout when given a non-finite value", async () => {
    const runner = createProcessRunner({
      timeoutMs: 1000,
      stdoutMaxBytes: 32,
      stderrMaxBytes: 32,
    });

    await expect(
      runner.execFile(node, ["-e", "setTimeout(() => {}, 50)"], { timeoutMs: NaN }),
    ).resolves.toEqual({ stdout: "", stderr: "" });
  });

  it("terminates commands on timeout and cancellation", async () => {
    const runner = createProcessRunner({
      timeoutMs: 25,
      stdoutMaxBytes: 32,
      stderrMaxBytes: 32,
    });
    await expect(runner.execFile(node, ["-e", "setTimeout(() => {}, 1000)"])).rejects.toMatchObject(
      {
        reason: "timeout",
      } satisfies Partial<CommandExecutionError>,
    );

    const controller = new AbortController();
    const command = runner.execFile(node, ["-e", "setTimeout(() => {}, 1000)"], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(command).rejects.toMatchObject({
      reason: "aborted",
    } satisfies Partial<CommandExecutionError>);
  });
});
