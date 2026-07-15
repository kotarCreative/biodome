import { execSync } from "node:child_process";
import { Plan } from "../core/plan.js";

export class Runner {
  project: string;
  prefix: string;
  network: string;

  constructor(project: string) {
    this.project = project;
    this.prefix = project;
    this.network = `${project}-net`;
  }

  build(rootDir: string): void {
    const tag = `${this.prefix}-dev:latest`;
    this.exec("docker", ["build", "-t", tag, "-f", ".sandbox/Dockerfile", rootDir], rootDir);
  }

  startDev(ctx: Plan, rootDir: string): void {
    this.ensureNetwork();
    const name = this.containerName("dev");
    const image = `${this.prefix}-dev:latest`;

    if (this.isRunning(name)) {
      throw new Error(`Dev container ${name} is already running`);
    }

    const args = [
      "run", "-d", "--rm",
      "--name", name,
      "--network", this.network,
      "-v", `${rootDir}:/workspace`,
      "-w", "/workspace",
    ];

    for (const [key, value] of Object.entries(ctx.runtime.environment)) {
      args.push("-e", `${key}=${value}`);
    }

    const daemonProcesses = ctx.runtime.processes.filter((p) => p.mode === "daemon");
    for (const proc of daemonProcesses) {
      for (const p of proc.ports) {
        args.push("-p", `${p.host}:${p.container}`);
      }
    }

    args.push(image);

    if (daemonProcesses.length === 0) {
      args.push("sleep", "infinity");
    }

    this.exec("docker", args, rootDir);
  }

  stopDev(): void {
    this.exec("docker", ["stop", "-t", "10", this.containerName("dev")]);
  }

  execInDev(command: string[]): void {
    const name = this.containerName("dev");
    this.exec("docker", ["exec", name, ...command]);
  }

  private ensureNetwork(): void {
    try {
      execSync(`docker network ls -q -f name=${this.network}`, { stdio: "pipe" });
    } catch {
      this.exec("docker", ["network", "create", this.network]);
    }
  }

  private isRunning(name: string): boolean {
    try {
      const out = execSync(`docker ps -q -f name=${name}`, { encoding: "utf-8", stdio: "pipe" });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  private containerName(name: string): string {
    return `${this.prefix}-${name}`;
  }

  private exec(cmd: string, args: string[], cwd?: string): void {
    const opts: any = { stdio: "inherit" };
    if (cwd) opts.cwd = cwd;
    execSync(`${cmd} ${args.map((a) => `"${a}"`).join(" ")}`, opts);
  }
}
