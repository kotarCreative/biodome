import { execSync } from "node:child_process";

const COMPOSE_FILE = ".sandbox/docker-compose.yaml";

export class Runner {
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

  private exec(cmd: string, args: string[], cwd?: string): void {
    const opts: any = { stdio: "inherit" };
    if (cwd) opts.cwd = cwd;
    execSync(`${cmd} ${args.map((a) => `"${a}"`).join(" ")}`, opts);
  }
}
