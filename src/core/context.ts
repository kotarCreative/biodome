import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  createPlan,
  Plan,
  Process,
  ProcessHealthCheck,
  Port,
  LifecyclePoint,
  Service,
} from "./plan.js";
import {
  FeatureContext,
  ProcessSpec,
  HookSpec,
  ProcessHealthCheckSpec,
  LanguageOptions,
  PackageOptions,
  ToolOptions,
  ServiceOptions,
} from "./feature.js";
import { BuildContext } from "./build-context.js";
import { languageHandlers } from "./languages.js";
import { formatPackage } from "./packages.js";
import { serviceConfigs, defaultImage } from "./services.js";
import { toolHandlers } from "./tools.js";

export class SandboxContext implements FeatureContext, BuildContext {
  plan: Plan;
  private rootDir: string;

  constructor(rootDir: string, project: string) {
    this.rootDir = rootDir;
    this.plan = createPlan(project);
  }

  addProcess(spec: ProcessSpec): void {
    const proc = this.normalizeProcess(spec, "daemon", "start.post");
    this.plan.runtime.processes.push(proc);
    this.mergeProcessEnv(proc);
  }

  addHook(spec: HookSpec): void {
    if (!spec.startOn) {
      throw new Error(`Hook ${spec.name} requires a startOn lifecycle point`);
    }
    const proc = this.normalizeProcess(spec, "oneshot", spec.startOn);
    this.plan.runtime.processes.push(proc);
    this.mergeProcessEnv(proc);
  }

  addLanguage(name: string, options: LanguageOptions = {}): void {
    const handler = languageHandlers[name];
    if (!handler) {
      return;
    }
    handler(this, options);
  }

  addPackage(manager: string, name: string, options: PackageOptions = {}): void {
    const commands: Record<string, string> = {
      npm: `npm install -g ${formatPackage(name, options)}`,
      pip: `pip install --no-cache-dir ${formatPackage(name, options, "==")}`,
      cargo: `cargo install ${name}`,
      go: `go install ${name}@latest`,
      gem: `gem install ${name}`,
    };

    const command = commands[manager];
    if (!command) {
      throw new Error(`Unknown package manager ${manager}`);
    }
    this.addLanguageSnippet(`RUN ${command}`);
  }

  addTool(name: string, _options: ToolOptions = {}): void {
    const handler = toolHandlers[name];
    if (handler) {
      handler(this);
    } else {
      // Unknown tools are treated as apt packages.
      this.addAptPackage(name);
    }
  }

  addAptPackage(name: string): void {
    if (!this.plan.build.aptPackages.includes(name)) {
      this.plan.build.aptPackages.push(name);
    }
  }

  addService(name: string, options: ServiceOptions = {}): void {
    let type = name;
    if (options.image) {
      // Custom image-based service; treat as a generic container.
      type = "container";
    }

    const svc: Service = {
      name,
      type,
      image: options.image || defaultImage(name),
      containerName: `${this.plan.project}-${name}`,
      environment: options.environment || {},
      ports: options.port ? [{ host: options.port, container: options.port }] : [],
      volumes: [],
      networks: ["sandbox"],
    };

    const config = serviceConfigs[type];
    if (config) {
      config(svc, options);
    }

    this.plan.runtime.services.push(svc);
    this.plan.runtime.volumes.push({ name: `${name}_data` });
  }

  setEnv(key: string, value: string): void {
    this.plan.build.environment[key] = value;
    this.plan.runtime.environment[key] = value;
  }

  fileExists(path: string): boolean {
    return existsSync(join(this.rootDir, path));
  }

  readFile(path: string): string {
    return readFileSync(join(this.rootDir, path), "utf-8");
  }

  readJSON(path: string): unknown {
    return JSON.parse(this.readFile(path));
  }

  exec(command: string): { stdout: string; stderr: string; exitCode: number } {
    console.log(`[exec] ${command}`);
    try {
      const stdout = execSync(command, {
        cwd: this.rootDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || "",
        exitCode: err.status || 1,
      };
    }
  }

  private normalizeProcess(
    spec: ProcessSpec,
    defaultMode: "daemon" | "oneshot",
    defaultStartOn: LifecyclePoint
  ): Process {
    const mode = spec.mode || defaultMode;
    const startOn = spec.startOn || defaultStartOn;

    const ports: Port[] = [];
    if (spec.port) {
      ports.push({ host: spec.port, container: spec.port });
    }
    if (spec.ports) {
      for (const p of Object.values(spec.ports)) {
        ports.push({ host: p, container: p });
      }
    }

    const healthCheck = spec.healthCheck
      ? this.normalizeHealthCheck(spec.healthCheck, spec.port)
      : undefined;

    return {
      name: spec.name,
      command: spec.command,
      ports,
      environment: spec.environment || {},
      workingDir: spec.workingDir,
      healthCheck,
      mode,
      startOn,
    };
  }

  private normalizeHealthCheck(
    spec: ProcessHealthCheckSpec,
    defaultPort?: number
  ): ProcessHealthCheck {
    const type = spec.type || "http";
    let url = spec.url;
    let port = spec.port;
    let command = spec.command;

    if (type === "http" && !url) {
      port = port || defaultPort;
      if (port) {
        url = `http://localhost:${port}`;
      }
    }

    if (type === "http") {
      this.addAptPackage("curl");
    }

    return {
      type,
      url,
      port,
      command,
      interval: spec.interval,
      timeout: spec.timeout,
      retries: spec.retries,
      startPeriod: spec.startPeriod,
    };
  }

  private mergeProcessEnv(proc: Process): void {
    for (const [key, value] of Object.entries(proc.environment)) {
      this.plan.runtime.environment[key] = value;
    }
  }

  addLanguageSnippet(snippet: string): void {
    if (!this.plan.build.languageSnippets.includes(snippet)) {
      this.plan.build.languageSnippets.push(snippet);
    }
  }
}

