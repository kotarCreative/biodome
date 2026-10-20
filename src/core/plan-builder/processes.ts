import { Schema } from "effect";
import {
  HookSpecSchema,
  type LifecyclePoint,
  type Plan,
  type Port,
  ProcessHealthCheckSpecSchema,
  type Process,
  ProcessSpecSchema,
  type ProcessHealthCheck,
} from "../plan.js";
import type { HookSpec, ProcessSpec } from "../feature.js";
import { ValidationError } from "../errors.js";
import { assertNoControlChars } from "../validation.js";
import { TaskContextImpl } from "../task-context.js";
import { actionCommand } from "../action-command.js";

export class ProcessBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly addAptPackage: (name: string) => void,
  ) {}

  addProcess(spec: ProcessSpec): void {
    const process = Schema.decodeSync(ProcessSpecSchema)(spec);
    this.add(process, "daemon", "start.post", "Process");
  }

  addHook(spec: HookSpec): void {
    const hook = Schema.decodeSync(HookSpecSchema)(spec);
    if (!hook.startOn) {
      throw new ValidationError({ message: "Hook requires a startOn lifecycle point" });
    }
    if (hook.intent !== undefined || hook.input !== undefined || hook.outputs !== undefined) {
      const context = new TaskContextImpl(hook.name);
      context.addAction({
        command: [...hook.command],
        intent: hook.intent ?? hook.name,
        input: hook.input ? { ...hook.input } : undefined,
        outputs: hook.outputs ? [...hook.outputs] : undefined,
      });
      this.add(
        { ...hook, command: actionCommand(context.getTask()) },
        "oneshot",
        hook.startOn,
        "Hook",
      );
    } else {
      this.add(hook, "oneshot", hook.startOn, "Hook");
    }
  }

  private add(
    spec: ProcessSpec,
    defaultMode: "daemon" | "oneshot",
    defaultStartOn: LifecyclePoint,
    label: "Process" | "Hook",
  ): void {
    this.validatePorts(spec, label);
    for (const [key, value] of Object.entries(spec.environment ?? {})) {
      // Rendered verbatim into supervisord config; newlines would start a new
      // INI directive.
      assertNoControlChars(value, `${label} ${spec.name}: environment.${key}`);
    }
    if (this.plan.runtime.processes.some((process) => process.name === spec.name)) {
      throw new ValidationError({ message: `Duplicate process or hook name: ${spec.name}` });
    }
    const process = this.normalize(spec, defaultMode, defaultStartOn);
    this.plan.runtime.processes.push(process);
    this.mergeEnvironment(process);
  }

  private validatePorts(spec: ProcessSpec, label: "Process" | "Hook"): void {
    this.validatePort(spec.port, `${label} ${spec.name}: port`);
    for (const [name, port] of Object.entries(spec.ports ?? {})) {
      this.validatePort(port, `${label} ${spec.name}: ports.${name}`);
    }
  }

  private validatePort(value: unknown, label: string): void {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
      throw new ValidationError({ message: `${label} must be an integer between 1 and 65535` });
    }
  }

  private normalize(
    spec: ProcessSpec,
    defaultMode: "daemon" | "oneshot",
    defaultStartOn: LifecyclePoint,
  ): Process {
    const healthCheck = spec.healthCheck
      ? this.normalizeHealthCheck(spec.healthCheck, spec.port)
      : undefined;
    return {
      name: spec.name,
      command: [...spec.command],
      ports: this.normalizePorts(spec),
      environment: spec.environment ? { ...spec.environment } : {},
      workingDir: this.normalizeWorkingDir(spec.workingDir),
      healthCheck,
      mode: spec.mode ?? defaultMode,
      startOn: spec.startOn ?? defaultStartOn,
      bootstrap: spec.bootstrap,
      mergeEnv: spec.mergeEnv,
      identity: spec.identity,
    };
  }

  private normalizePorts(spec: ProcessSpec): Port[] {
    const ports: Port[] = [];
    if (spec.port) ports.push({ host: spec.port, container: spec.port });
    for (const [name, port] of Object.entries(spec.ports ?? {})) {
      ports.push({ name, host: port, container: port });
    }
    return ports;
  }

  private normalizeWorkingDir(workingDir: string | undefined): string | undefined {
    if (!workingDir) return undefined;
    return workingDir.startsWith("/") ? workingDir : `/workspace/${workingDir}`;
  }

  private normalizeHealthCheck(
    spec: typeof ProcessHealthCheckSpecSchema.Type,
    defaultPort?: number,
  ): ProcessHealthCheck {
    const type = spec.type ?? "http";
    let url = spec.url;
    let port = spec.port;
    if (type === "http" && !url) {
      port = port ?? defaultPort;
      if (port) url = `http://localhost:${port}`;
    }
    if (type === "http") this.addAptPackage("curl");
    if (type === "tcp") this.addAptPackage("netcat-openbsd");
    return {
      type,
      url,
      port,
      command: spec.command ? [...spec.command] : undefined,
      interval: spec.interval,
      timeout: spec.timeout,
      retries: spec.retries,
      startPeriod: spec.startPeriod,
    };
  }

  private mergeEnvironment(process: Process): void {
    // Process environments are scoped by default: volume, provider, and MCP
    // credentials must not leak into sibling processes or the compose
    // dev service. Sharing is an explicit opt-in.
    if (process.mergeEnv !== true) return;
    for (const [key, value] of Object.entries(process.environment)) {
      if (this.plan.runtime.envVars.some((env) => env.key === key)) continue;
      this.plan.runtime.environment[key] = value;
    }
  }
}
