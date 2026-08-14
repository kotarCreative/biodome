import { spawn } from "node:child_process";

export interface CommandLimits {
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
}

export interface CommandRunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export class CommandExecutionError extends Error {
  constructor(
    readonly reason: "aborted" | "exit" | "spawn" | "stderr_limit" | "stdout_limit" | "timeout",
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode?: number,
  ) {
    super(
      reason === "timeout"
        ? "Command timed out"
        : reason === "aborted"
          ? "Command cancelled"
          : reason === "stdout_limit"
            ? "Command stdout exceeded its byte limit"
            : reason === "stderr_limit"
              ? "Command stderr exceeded its byte limit"
              : exitCode === undefined
                ? "Command could not be started"
                : `Command exited with code ${exitCode}`,
    );
    this.name = "CommandExecutionError";
  }
}

export interface ProcessRunner {
  exec(
    command: string,
    options: CommandRunOptions,
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
  execFile(
    file: string,
    arguments_: readonly string[],
    options?: CommandRunOptions,
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  bytes: number,
  limit: number,
): number | null {
  const remaining = limit - bytes;
  if (remaining <= 0) return null;
  if (chunk.length > remaining) {
    chunks.push(chunk.subarray(0, remaining));
    return null;
  }
  chunks.push(chunk);
  return bytes + chunk.length;
}

function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export function createProcessRunner(limits: CommandLimits): ProcessRunner {
  const run = (
    file: string,
    arguments_: readonly string[],
    shell: boolean,
    options: CommandRunOptions = {},
  ): Promise<{ readonly stdout: string; readonly stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(file, arguments_, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        shell,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure:
        | { readonly reason: CommandExecutionError["reason"]; readonly exitCode?: number }
        | undefined;
      let terminated = false;
      let killTimer: NodeJS.Timeout | undefined;
      const requestedTimeoutMs = options.timeoutMs ?? limits.timeoutMs;
      const timeoutMs = Math.min(
        Number.isFinite(requestedTimeoutMs) ? requestedTimeoutMs : limits.timeoutMs,
        limits.timeoutMs,
      );
      const finish = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
      };
      const makeError = (
        reason: CommandExecutionError["reason"],
        exitCode?: number,
      ): CommandExecutionError =>
        new CommandExecutionError(
          reason,
          Buffer.concat(stdout).toString(),
          Buffer.concat(stderr).toString(),
          exitCode,
        );
      const terminate = (reason: CommandExecutionError["reason"], exitCode?: number) => {
        if (failure) return;
        failure = { reason, exitCode };
        if (terminated) return;
        terminated = true;
        terminateProcess(child);
        killTimer = setTimeout(() => {
          if (child.pid === undefined) return;
          if (process.platform === "win32") child.kill("SIGKILL");
          else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        }, 1000);
        killTimer.unref();
      };
      const abort = () => terminate("aborted");
      const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
      timeout.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        const next = appendBounded(stdout, chunk, stdoutBytes, limits.stdoutMaxBytes);
        if (next === null) terminate("stdout_limit");
        else stdoutBytes = next;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const next = appendBounded(stderr, chunk, stderrBytes, limits.stderrMaxBytes);
        if (next === null) terminate("stderr_limit");
        else stderrBytes = next;
      });
      child.once("error", () => {
        finish();
        reject(failure ? makeError(failure.reason, failure.exitCode) : makeError("spawn"));
      });
      child.once("close", (code) => {
        finish();
        if (failure) reject(makeError(failure.reason, failure.exitCode));
        else if (code !== 0) reject(makeError("exit", code ?? undefined));
        else
          resolve({
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          });
      });
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });

  return {
    exec: (command, options) => run(command, [], true, options),
    execFile: (file, arguments_, options) => run(file, arguments_, false, options),
  };
}
