import { Effect, Option, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { NodeRuntime } from "../core/runtime-node.js";
import { RuntimeError } from "../core/errors.js";
import type { RuntimeOperationInput } from "./driver.js";

/** Hard cap on stdout/stderr bytes retained per stream from a captured child process. */
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Grace period granted after SIGTERM before a hung child receives SIGKILL. */
export const KILL_AFTER_SECONDS = 5;
/** Exit code GNU `timeout` reports when it terminates a command. */
export const TIMEOUT_EXIT_CODE = 124;

export function platformErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}

export function toRuntimeError(error: unknown): RuntimeError {
  return error instanceof RuntimeError
    ? error
    : new RuntimeError({ message: platformErrorMessage(error) });
}

const PROCESS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function assertProcessName(name: string): string {
  if (!PROCESS_NAME_PATTERN.test(name)) {
    throw new RuntimeError({
      message: `Invalid process name: ${JSON.stringify(name)} must match ${PROCESS_NAME_PATTERN.source}`,
    });
  }
  return name;
}

export function stagingImageRef(input: RuntimeOperationInput): string {
  return `${input.plan.project}-dev:${input.deploymentId}-build`;
}

export function imageRefFromLocalDigest(digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new RuntimeError({ message: `Docker returned an invalid image digest: ${digest}` });
  }
  return digest;
}

/**
 * Prefix a command with a GNU `timeout` invocation so overruns receive SIGTERM
 * and, after KILL_AFTER_SECONDS, SIGKILL inside the container or sandbox.
 */
export function execArgsWithTimeout(
  prefix: string[],
  command: string[],
  timeoutMs?: number,
): string[] {
  if (timeoutMs === undefined) return [...prefix, ...command];

  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    ...prefix,
    "timeout",
    "--signal=TERM",
    `--kill-after=${KILL_AFTER_SECONDS}s`,
    `${timeoutSeconds}s`,
    ...command,
  ];
}

export interface ProcessOptions {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  /** Extra environment variables layered over the host environment. */
  readonly env?: Record<string, string>;
}

function mergedEnv(env: Record<string, string> | undefined) {
  return env ? { ...process.env, ...env } : undefined;
}

/**
 * Default runtime-identity mapping for local compose flows: the container's
 * runtime user is mapped onto this host's uid/gid so workspace bind mounts
 * stay writable without chowning host files. Explicit host exports win.
 */
export function hostIdentityMappingEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.BIODOME_RUNTIME_UID === undefined && typeof process.getuid === "function") {
    env.BIODOME_RUNTIME_UID = String(process.getuid());
  }
  if (process.env.BIODOME_RUNTIME_GID === undefined && typeof process.getgid === "function") {
    env.BIODOME_RUNTIME_GID = String(process.getgid());
  }
  return env;
}

/**
 * Spawn a child process inheriting stdio, failing on a nonzero exit.
 */
export function runProcess(options: ProcessOptions): Effect.Effect<void, RuntimeError, never> {
  return Effect.gen(function* () {
    const handle = yield* ChildProcess.make(options.command, options.args, {
      cwd: options.cwd,
      env: mergedEnv(options.env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = yield* handle.exitCode;
    if (exitCode !== 0) {
      return yield* new RuntimeError({
        message: `exited with code ${exitCode}`,
        command: `${options.command} ${options.args.join(" ")}`,
      });
    }
  }).pipe(
    Effect.provide(NodeRuntime),
    Effect.scoped,
    Effect.catch((error) => Effect.fail(toRuntimeError(error))),
  );
}

export interface CaptureOptions extends ProcessOptions {
  /** Per-stream byte cap. Defaults to MAX_BUFFER_BYTES. */
  readonly maxBytes?: number;
  /**
   * Kill the child after this many milliseconds, escalating SIGTERM to SIGKILL
   * after KILL_AFTER_SECONDS. Omit to wait indefinitely.
   */
  readonly timeoutMs?: number;
  readonly stdin?: "inherit" | "ignore";
}

export interface CapturedOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function collectBoundedOutput(
  stream: Stream.Stream<Uint8Array, PlatformError>,
  maxBytes: number,
): Effect.Effect<string, PlatformError> {
  return Stream.runFold(
    stream,
    () => ({ chunks: [] as Uint8Array[], size: 0 }),
    (output, chunk) => {
      const remaining = maxBytes - output.size;
      if (remaining <= 0) return output;
      const retained = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      output.chunks.push(retained);
      output.size += retained.byteLength;
      return output;
    },
  ).pipe(Effect.map(({ chunks, size }) => Buffer.concat(chunks, size).toString("utf8")));
}

/**
 * Spawn a child process with piped output, capturing independently bounded
 * stdout/stderr. A nonzero exit is reported, not failed.
 */
export function captureProcess(
  options: CaptureOptions,
): Effect.Effect<CapturedOutput, RuntimeError, never> {
  const maxBytes = options.maxBytes ?? MAX_BUFFER_BYTES;
  return Effect.gen(function* () {
    const handle = yield* ChildProcess.make(options.command, options.args, {
      cwd: options.cwd,
      env: mergedEnv(options.env),
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const wait = Effect.all(
      [
        handle.exitCode,
        collectBoundedOutput(handle.stdout, maxBytes),
        collectBoundedOutput(handle.stderr, maxBytes),
      ],
      { concurrency: "unbounded" },
    );
    if (options.timeoutMs === undefined) {
      const [exitCode, stdout, stderr] = yield* wait;
      return { exitCode, stdout, stderr };
    }
    const outcome = yield* Effect.timeoutOption(wait, `${options.timeoutMs} millis`);
    if (Option.isNone(outcome)) {
      yield* handle.kill({ forceKillAfter: `${KILL_AFTER_SECONDS} seconds` }).pipe(Effect.ignore);
      return yield* new RuntimeError({
        message: `${options.command} ${options.args.join(" ")} timed out after ${options.timeoutMs}ms`,
        command: `${options.command} ${options.args.join(" ")}`,
      });
    }
    const [exitCode, stdout, stderr] = outcome.value;
    return { exitCode, stdout, stderr };
  }).pipe(
    Effect.provide(NodeRuntime),
    Effect.scoped,
    Effect.catch((error) => Effect.fail(toRuntimeError(error))),
  );
}

/**
 * Capture a command's trimmed stdout, failing with its stderr (falling back to
 * the exit code) on a nonzero exit.
 */
export function captureCommandOutput(
  options: CaptureOptions,
): Effect.Effect<string, RuntimeError, never> {
  return Effect.gen(function* () {
    const captured = yield* captureProcess(options);
    if (captured.exitCode !== 0) {
      return yield* new RuntimeError({
        message: captured.stderr || `exited with code ${captured.exitCode}`,
        command: `${options.command} ${options.args.join(" ")}`,
      });
    }
    return captured.stdout.trim();
  });
}
