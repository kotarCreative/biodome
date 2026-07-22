// SandboxRuntime abstracts the lifecycle of a sandbox environment.
// The default implementation is Docker Compose, but the interface is backend
// agnostic so remote, cloud, or in-process runtimes can be swapped in without
// changing the calling code.

import { Effect } from "effect";
import { RuntimeError } from "./errors.js";
import type { Capabilities } from "./capabilities.js";
import type { EventStore } from "./events.js";

export interface SandboxRuntime {
  readonly project: string;

  /** Features this runtime backend supports (e.g. snapshots, PTYs, network policies). */
  readonly capabilities: Capabilities;

  /** Verify that the runtime backend is reachable (Docker daemon, remote API, etc.). */
  ensureAvailable(): Effect.Effect<void, RuntimeError, EventStore>;

  /** Prepare/build the environment (images, packages, generated assets). */
  build(rootDir: string): Effect.Effect<void, RuntimeError, EventStore>;

  /** Start the environment. When `build` is true, rebuild first. */
  start(rootDir: string, build?: boolean): Effect.Effect<void, RuntimeError, EventStore>;

  /** Stop the environment. */
  stop(rootDir?: string): Effect.Effect<void, RuntimeError, EventStore>;

  /** Execute a command inside the development environment. */
  exec(command: string[]): Effect.Effect<void, RuntimeError, EventStore>;

  /** Show runtime status (running containers, processes, etc.). */
  status(): Effect.Effect<void, RuntimeError, EventStore>;

  /** Stream logs from the dev environment or a named process. */
  logs(processName?: string): Effect.Effect<void, RuntimeError, EventStore>;

  /** Restart a managed process. */
  restart(processName: string): Effect.Effect<void, RuntimeError, EventStore>;
}
