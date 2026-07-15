// Provider abstracts the runtime that manages sandbox containers.
// The default implementation is Docker Compose, but the interface leaves room
// for remote or alternative backends.

export interface Provider {
  readonly project: string;

  build(rootDir: string): void;
  up(rootDir: string, build?: boolean): void;
  down(rootDir?: string): void;
  execInDev(command: string[]): void;
  ps(): void;
  restart(processName: string): void;
}
