import { Schema } from "effect";
import { type Plan, type Service, ServiceOptionsSchema } from "../plan.js";
import type { ProcessSpec, ServiceOptions } from "../feature.js";
import { ValidationError } from "../errors.js";
import { defaultImage, serviceConfigs } from "../services.js";

export class ServiceBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly addAptPackage: (name: string) => void,
    private readonly addProcess: (spec: ProcessSpec) => void,
    private readonly addHook: (spec: ProcessSpec) => void,
    private readonly servicesPath: string,
  ) {}

  add(name: string, options: ServiceOptions = {}): void {
    if (!name || typeof name !== "string") {
      throw new ValidationError({ message: "Service requires a non-empty string name" });
    }
    const validated = Schema.decodeSync(ServiceOptionsSchema)(options);
    this.validatePort(validated.port, `Service ${name}: port`);

    if (this.plan.runtime.services.some((service) => service.name === name)) {
      throw new ValidationError({ message: `Duplicate service name: ${name}` });
    }

    const type = validated.image ? "container" : name;
    const service: Service = {
      name,
      type,
      runtime: type === "postgres" ? "process" : "container",
      image: validated.image || defaultImage(name),
      containerName: `${this.plan.project}-${name}`,
      environment: validated.environment || {},
      ports: validated.port ? [{ host: validated.port, container: validated.port }] : [],
      volumes: [],
      networks: ["biodome"],
    };

    serviceConfigs[type]?.(service, validated);
    this.plan.runtime.services.push(service);
    if (service.runtime === "process" && service.type === "postgres") {
      this.addAptPackage("postgresql");
      this.addProcess({
        name: `${name}-server`,
        command: ["sh", `${this.servicesPath}/${name}.sh`],
        healthCheck: { type: "tcp", port: 5432, interval: "1s", retries: 30, startPeriod: "1s" },
        bootstrap: true,
      });
      this.addHook({
        name: `${name}-init`,
        command: ["sh", `${this.servicesPath}/${name}-init.sh`],
        startOn: "start.pre",
      });
    }
    for (const volume of service.volumes) {
      if (
        !volume.host.startsWith("/") &&
        !volume.host.startsWith("./") &&
        !volume.host.startsWith("~")
      ) {
        this.plan.runtime.namedVolumes.push({ name: volume.host });
      }
    }
  }

  private validatePort(value: unknown, label: string): void {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
      throw new ValidationError({ message: `${label} must be an integer between 1 and 65535` });
    }
  }
}
