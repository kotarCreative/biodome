import { execFileSync, StdioOptions } from "node:child_process";
import type { Provider } from "../core/provider.js";

const COMPOSE_FILE = ".sandbox/docker-compose.yaml";

export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerError";
  }
}

export function assertDockerAvailable(): void {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
  } catch {
    throw new DockerError(
      "Docker is not available or the daemon is not running. " +
        "Make sure Docker is installed and started, or run a command that does not need Docker (e.g. 'sandbox config validate')."
    );
  }
}

export class Runner implements Provider {
  project: string;

  constructor(project: string) {
    this.project = project;
  }

  build(rootDir: string): void {
    this.exec("docker", ["compose", "-f", COMPOSE_FILE, "-p", this.project, "build"], rootDir);
  }

  up(rootDir: string, build = false): void {
    const args = ["compose", "-f", COMPOSE_FILE, "-p", this.project, "up", "-d"];
    if (build) {
      args.push("--build");
    }
    this.exec("docker", args, rootDir);
  }

  down(rootDir?: string): void {
    this.exec("docker", ["compose", "-f", COMPOSE_FILE, "-p", this.project, "down"], rootDir);
  }

  execInDev(command: string[]): void {
    this.exec("docker", ["exec", `${this.project}-dev`, ...command]);
  }

  ps(): void {
    this.exec("docker", ["compose", "-f", COMPOSE_FILE, "-p", this.project, "ps"]);
  }

  restart(processName: string): void {
    this.exec("docker", ["exec", `${this.project}-dev`, "supervisorctl", "restart", processName]);
  }

  private exec(cmd: string, args: string[], cwd?: string): void {
    const options: { stdio: StdioOptions; cwd?: string } = { stdio: "inherit" };
    if (cwd) options.cwd = cwd;
    execFileSync(cmd, args, options);
  }
}
