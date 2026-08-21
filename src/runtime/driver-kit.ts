import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { NodeRuntime } from "../core/runtime-node.js";
import { RuntimeError } from "../core/errors.js";
import type { Artifact, CommandResult } from "./driver.js";
import { TIMEOUT_EXIT_CODE, assertProcessName, captureProcess, toRuntimeError } from "./proc.js";

/**
 * Composition helpers shared by runtime drivers that drive a container CLI
 * (`docker`, `sbx`, ...). Drivers keep their provider-specific build/start
 * logic and delegate this plumbing instead of re-implementing it.
 */

/** Verify a CLI answers `version`, failing with actionable guidance. */
export function ensureCliAvailable(
  command: string,
  unavailableMessage: string,
): Effect.Effect<void, RuntimeError, never> {
  return Effect.gen(function* () {
    const handle = yield* ChildProcess.make(command, ["version"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = yield* handle.exitCode;
    if (exitCode !== 0) {
      return yield* new RuntimeError({ message: unavailableMessage });
    }
  }).pipe(
    Effect.provide(NodeRuntime),
    Effect.scoped,
    Effect.catch((error) => Effect.fail(toRuntimeError(error))),
  );
}

export interface ExecCaptureOptions {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  /**
   * Enforced by prefixing the command with GNU `timeout` (see
   * execArgsWithTimeout). While set, stdio is not attached to the terminal.
   */
  readonly timeoutMs?: number;
}

/**
 * Capture an in-container exec command and report duration plus the GNU
 * `timeout` exit-code semantics shared by every local driver.
 */
export function captureTimedExec(
  options: ExecCaptureOptions,
): Effect.Effect<CommandResult, RuntimeError, never> {
  const start = Date.now();
  return Effect.gen(function* () {
    const { exitCode, stdout, stderr } = yield* captureProcess({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      stdin: options.timeoutMs === undefined ? "inherit" : "ignore",
    });
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - start,
      timedOut: options.timeoutMs !== undefined && exitCode === TIMEOUT_EXIT_CODE,
    };
  });
}

/** Artifact paths are workspace-relative POSIX paths; reject anything else. */
export function assertRelativeArtifactPath(path: string): void {
  if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new RuntimeError({
      message: `Invalid artifact path "${path}": must be a relative path without traversal`,
    });
  }
}

export interface CopyCollectOptions {
  readonly outputDir: string;
  readonly paths: string[];
  /**
   * Copy one validated workspace-relative path into the prepared localPath.
   * A failure means the path was not collected; describeMissing renders the
   * driver-specific error.
   */
  readonly copy: (path: string, localPath: string) => Effect.Effect<string, RuntimeError, never>;
  readonly describeMissing: (path: string) => string;
}

/**
 * Collect artifacts one copy per declared path into
 * `<outputDir>/artifacts/<path>`, the layout shared by local drivers.
 */
export function collectArtifactsByCopying(
  options: CopyCollectOptions,
): Effect.Effect<Artifact[], RuntimeError, never> {
  return Effect.gen(function* () {
    const artifactsDir = join(options.outputDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const artifacts: Artifact[] = [];
    for (const path of options.paths) {
      yield* Effect.try({
        try: () => assertRelativeArtifactPath(path),
        catch: toRuntimeError,
      });
      const localPath = join(artifactsDir, path);
      mkdirSync(dirname(localPath), { recursive: true });
      const copied = yield* Effect.result(options.copy(path, localPath));
      if (copied._tag === "Failure") {
        return yield* new RuntimeError({ message: options.describeMissing(path) });
      }
      artifacts.push({ path, localPath, sizeBytes: statSync(localPath).size });
    }
    return artifacts;
  });
}

/** Resolve the supervisord log file for a process, or the main log when unset. */
export function supervisordLogFile(logDir: string, processName?: string): string {
  const name = processName ? assertProcessName(processName) : undefined;
  return `${logDir}/${name ?? "supervisord"}.log`;
}

/** Build a supervisorctl invocation against the generated config. */
export function supervisorctlArgs(
  supervisordConfig: string,
  action: string,
  processNames: string[],
): string[] {
  return ["supervisorctl", "-c", supervisordConfig, action, ...processNames];
}
