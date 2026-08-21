import { Schema } from "effect";
import { type Plan, type Service, ServiceOptionsSchema } from "../plan.js";
import type { EnvSpec, ProcessSpec, ServiceOptions } from "../feature.js";
import { ValidationError } from "../errors.js";
import {
  POSTGRES_PASSWORD_ENV_VAR,
  SUPPORTED_SERVICE_TYPES,
  serviceConfigs,
  servicePassword,
} from "../services.js";

// Default TCP port per supported in-container service type.
const SERVICE_DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  redis: 6379,
};

export class ServiceBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly addAptPackage: (name: string) => void,
    private readonly addProcess: (spec: ProcessSpec) => void,
    private readonly addHook: (spec: ProcessSpec) => void,
    private readonly servicesPath: string,
    private readonly addEnv: (key: string, spec: EnvSpec) => void,
  ) {}

  add(name: string, options: ServiceOptions = {}): void {
    if (!name || typeof name !== "string") {
      throw new ValidationError({ message: "Service requires a non-empty string name" });
    }
    if (!SUPPORTED_SERVICE_TYPES.has(name)) {
      throw new ValidationError({
        message:
          `Unsupported service "${name}". Services run inside the dev image as managed ` +
          `processes; supported types: ${[...SUPPORTED_SERVICE_TYPES].sort().join(", ")}.`,
      });
    }
    const validated = Schema.decodeSync(ServiceOptionsSchema)(options);
    this.validatePort(validated.port, `Service ${name}: port`);

    if (this.plan.runtime.services.some((service) => service.name === name)) {
      throw new ValidationError({ message: `Duplicate service name: ${name}` });
    }

    const service: Service = {
      name,
      type: name,
      environment: validated.environment || {},
      ports: validated.port ? [{ host: validated.port, container: validated.port }] : [],
    };

    serviceConfigs[name]?.(service, validated);
    this.plan.runtime.services.push(service);

    const port = validated.port ?? SERVICE_DEFAULT_PORTS[name];
    if (name === "postgres") {
      this.addAptPackage("postgresql");
      this.addProcess({
        name: `${name}-server`,
        command: ["sh", `${this.servicesPath}/${name}.sh`],
        healthCheck: { type: "tcp", port, interval: "1s", retries: 30, startPeriod: "1s" },
        bootstrap: true,
      });
      this.addHook({
        name: `${name}-init`,
        command: ["sh", `${this.servicesPath}/${name}-init.sh`],
        startOn: "start.pre",
      });
      // The init script reads the role password from the container environment,
      // so declare it as a runtime env var: literals are injected verbatim,
      // while { env } references become required host passthroughs that fail
      // `docker compose` loudly when unset. The value never touches disk.
      const password = servicePassword(validated);
      if (password !== undefined) {
        if (typeof password === "string") {
          this.addEnv(POSTGRES_PASSWORD_ENV_VAR, { value: password });
        } else {
          this.addEnv(POSTGRES_PASSWORD_ENV_VAR, {
            from: { env: password.env },
            required: true,
          });
        }
      }
    } else if (name === "redis") {
      this.addAptPackage("redis-server");
      this.addProcess({
        name: `${name}-server`,
        command: ["sh", `${this.servicesPath}/${name}.sh`],
        healthCheck: { type: "tcp", port, interval: "1s", retries: 30, startPeriod: "1s" },
        bootstrap: true,
      });
    }
  }

  private validatePort(value: unknown, label: string): void {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
      throw new ValidationError({ message: `${label} must be an integer between 1 and 65535` });
    }
  }
}
