// SandboxRuntime abstracts the lifecycle of a sandbox environment.
// The default implementation is Docker Compose, but the interface is backend
// agnostic so remote, cloud, or in-process runtimes can be swapped in without
// changing the calling code.

import { Effect } from "effect"
import { RuntimeError } from "./errors.js"

export interface SandboxRuntime {
  readonly project: string

  /** Verify that the runtime backend is reachable (Docker daemon, remote API, etc.). */
  ensureAvailable(): Effect.Effect<void, RuntimeError, never>

  /** Prepare/build the environment (images, packages, generated assets). */
  build(rootDir: string): Effect.Effect<void, RuntimeError, never>

  /** Start the environment. When `build` is true, rebuild first. */
  start(rootDir: string, build?: boolean): Effect.Effect<void, RuntimeError, never>

  /** Stop the environment. */
  stop(rootDir?: string): Effect.Effect<void, RuntimeError, never>

  /** Execute a command inside the development environment. */
  exec(command: string[]): Effect.Effect<void, RuntimeError, never>

  /** Show runtime status (running containers, processes, etc.). */
  status(): Effect.Effect<void, RuntimeError, never>

  /** Stream logs from the dev environment or a named process. */
  logs(processName?: string): Effect.Effect<void, RuntimeError, never>

  /** Restart a managed process. */
  restart(processName: string): Effect.Effect<void, RuntimeError, never>
}
