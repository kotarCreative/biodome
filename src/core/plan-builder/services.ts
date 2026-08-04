import { Schema } from "effect";
import { type Plan, type Service, ServiceOptionsSchema } from "../plan.js";
import type { ServiceOptions } from "../feature.js";
import { ValidationError } from "../errors.js";
import { defaultImage, serviceConfigs } from "../services.js";

export class ServiceBuilder {
  constructor(private readonly plan: Plan) {}

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
      image: validated.image || defaultImage(name),
      containerName: `${this.plan.project}-${name}`,
      environment: validated.environment || {},
      ports: validated.port ? [{ host: validated.port, container: validated.port }] : [],
      volumes: [],
      networks: ["biodome"],
    };

    serviceConfigs[type]?.(service, validated);
    this.plan.runtime.services.push(service);
    for (const volume of service.volumes) {
      if (!volume.host.startsWith("/") && !volume.host.startsWith("./") && !volume.host.startsWith("~")) {
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
