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
  DependencyInstall,
  CopyArtifact,
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

const LIFECYCLE_POINTS = new Set<string>([
  "build.pre",
  "build.post",
  "start.pre",
  "start.post",
  "stop.pre",
  "stop.post",
  "exec.pre",
  "exec.post",
]);

function validateName(name: unknown, label: string): void {
  if (!name || typeof name !== "string") {
    throw new Error(`${label} requires a non-empty string name`);
  }
}

function validateCommand(command: unknown, label: string): void {
  if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== "string")) {
    throw new Error(`${label} must be a non-empty array of strings`);
  }
}

function validatePort(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
}

function validateEnv(env: Record<string, unknown>, label: string): asserts env is Record<string, string> {
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error(`${label} must be a record of strings`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
  }
}

function validateLifecyclePoint(value: unknown, label: string): void {
  if (value !== undefined && !LIFECYCLE_POINTS.has(value as string)) {
    throw new Error(`${label} must be a valid lifecycle point`);
  }
}

export class SandboxContext implements FeatureContext, BuildContext {
  plan: Plan;
  private rootDir: string;
  private dryRun: boolean;

  constructor(rootDir: string, project: string, dryRun = false) {
    this.rootDir = rootDir;
    this.dryRun = dryRun;
    this.plan = createPlan(project);
  }

  addProcess(spec: ProcessSpec): void {
    validateName(spec.name, "Process");
    validateCommand(spec.command, `Process ${spec.name}: command`);
    validatePort(spec.port, `Process ${spec.name}: port`);
    validateLifecyclePoint(spec.startOn, `Process ${spec.name}: startOn`);
    if (spec.ports) {
      for (const [portName, port] of Object.entries(spec.ports)) {
        validatePort(port, `Process ${spec.name}: ports.${portName}`);
      }
    }
    if (spec.environment) {
      validateEnv(spec.environment as Record<string, unknown>, `Process ${spec.name}: environment`);
    }

    this.assertUniqueProcessName(spec.name);
    const proc = this.normalizeProcess(spec, "daemon", "start.post");
    this.plan.runtime.processes.push(proc);
    this.mergeProcessEnv(proc);
  }

  addHook(spec: HookSpec): void {
    validateName(spec.name, "Hook");
    validateCommand(spec.command, `Hook ${spec.name}: command`);
    validateLifecyclePoint(spec.startOn, `Hook ${spec.name}: startOn`);
    validatePort(spec.port, `Hook ${spec.name}: port`);
    if (spec.ports) {
      for (const [portName, port] of Object.entries(spec.ports)) {
        validatePort(port, `Hook ${spec.name}: ports.${portName}`);
      }
    }
    if (spec.environment) {
      validateEnv(spec.environment as Record<string, unknown>, `Hook ${spec.name}: environment`);
    }

    if (!spec.startOn) {
      throw new Error(`Hook ${spec.name} requires a startOn lifecycle point`);
    }

    this.assertUniqueProcessName(spec.name);
    const proc = this.normalizeProcess(spec, "oneshot", spec.startOn);
    this.plan.runtime.processes.push(proc);
    this.mergeProcessEnv(proc);
  }

  private assertUniqueProcessName(name: string): void {
    if (this.plan.runtime.processes.some((p) => p.name === name)) {
      throw new Error(`Duplicate process or hook name: ${name}`);
    }
  }

  addLanguage(name: string, options: LanguageOptions = {}): void {
    const handler = languageHandlers[name];
    if (!handler) {
      return;
    }
    if (this.plan.build.baseImage) {
      console.warn(
        `[warn] Language ${name} is ignored: a base image is already set by a previous language. Only one base image is supported.`
      );
      return;
    }
    handler(this, options);
  }

  addPackage(manager: string, name: string, options: PackageOptions = {}): void {
    validateName(name, "Package");
    const registryFlag = options.indexUrl ? ` --registry ${options.indexUrl}` : "";
    const indexUrlFlag = options.indexUrl ? ` --index-url ${options.indexUrl}` : "";

    const commands: Record<string, string> = {
      npm: `npm install -g${registryFlag} ${formatPackage(name, options)}`,
      pip: `pip install --no-cache-dir${indexUrlFlag} ${formatPackage(name, options, "==")}`,
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
    validateName(name, "Tool");
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
    validateName(name, "Service");
    validatePort(options.port, `Service ${name}: port`);
    if (options.environment) {
      validateEnv(options.environment as Record<string, unknown>, `Service ${name}: environment`);
    }

    if (this.plan.runtime.services.some((s) => s.name === name)) {
      throw new Error(`Duplicate service name: ${name}`);
    }

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
    for (const vol of svc.volumes) {
      if (!vol.host.startsWith("/") && !vol.host.startsWith("./") && !vol.host.startsWith("~")) {
        this.plan.runtime.volumes.push({ name: vol.host });
      }
    }
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
    if (this.dryRun) {
      console.log(`[exec] (dry run) ${command}`);
      return { stdout: "", stderr: "", exitCode: 0 };
    }

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

  // BuildContext helpers — encapsulate plan mutations.

  setBaseImage(name: string): boolean {
    if (this.plan.build.baseImage) {
      return false;
    }
    this.plan.build.baseImage = name;
    return true;
  }

  requireDependencyFiles(files: string[]): string[] {
    const existing: string[] = [];
    for (const file of files) {
      if (this.fileExists(file)) {
        existing.push(file);
        if (!this.plan.build.dependencyFiles.includes(file)) {
          this.plan.build.dependencyFiles.push(file);
        }
      }
    }
    return existing;
  }

  addDependencyInstall(install: DependencyInstall): void {
    this.plan.build.dependencyInstalls.push(install);
  }

  addCopyArtifact(artifact: CopyArtifact): void {
    this.plan.build.copyArtifacts.push(artifact);
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
      for (const [portName, p] of Object.entries(spec.ports)) {
        ports.push({ name: portName, host: p, container: p });
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
      workingDir: this.normalizeWorkingDir(spec.workingDir),
      healthCheck,
      mode,
      startOn,
    };
  }

  private normalizeWorkingDir(workingDir: string | undefined): string | undefined {
    if (!workingDir) return undefined;
    if (workingDir.startsWith("/")) return workingDir;
    return `/workspace/${workingDir}`;
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

    if (type === "tcp") {
      this.addAptPackage("netcat-openbsd");
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

  enableNodeModulesVolume(): void {
    this.plan.build.nodeModulesVolume = true;
  }

  enableVenvVolume(): void {
    this.plan.build.venvVolume = true;
  }
}
