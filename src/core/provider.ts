// Provider abstracts the runtime that manages sandbox containers.
// The default implementation is Docker Compose, but the interface leaves room
// for remote or alternative backends.

import { Effect } from "effect"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { DockerError } from "./errors.js"

export interface Provider {
  readonly project: string

  build(rootDir: string): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner>
  up(rootDir: string, build?: boolean): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner>
  down(rootDir?: string): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner>
  execInDev(command: string[]): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner>
  ps(): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner>
  restart(processName: string): Effect.Effect<void, DockerError, ChildProcessSpawner.ChildProcessSpawner>
}
