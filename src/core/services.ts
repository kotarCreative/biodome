import type { SecretReference } from "./secrets.js";
import { Service } from "./plan.js";
import { ServiceOptions } from "./feature.js";

// The container environment variable carrying the service credential. The
// generated init scripts read it at run time; it is never baked into files.
export const POSTGRES_PASSWORD_ENV_VAR = "POSTGRES_PASSWORD";

// The declared credential for a service: users[0].password, falling back to
// the top-level options.password.
export function servicePassword(options: ServiceOptions): string | SecretReference | undefined {
  return options.users?.[0]?.password ?? options.password;
}

// Every declared backing service runs inside the dev image as a supervised
// process under a dedicated system user, so a deployment is exactly one image.
export const SUPPORTED_SERVICE_TYPES = new Set(["postgres", "redis"]);

// The OS account (created by the service's apt package) each in-container
// service runs as.
export const SERVICE_SYSTEM_USERS: Record<string, string> = {
  postgres: "postgres",
  redis: "redis",
};

export function systemUserForService(type: string): string | undefined {
  return SERVICE_SYSTEM_USERS[type];
}

export const serviceConfigs: Record<string, (svc: Service, options: ServiceOptions) => void> = {
  postgres: (svc, options) => {
    const user = options.users?.[0]?.name || "postgres";
    const database = options.databases?.[0]?.name || "postgres";
    svc.environment.POSTGRES_USER = user;
    // Only literal credentials are recorded on the service; env references are
    // injected as passthrough runtime variables instead so the secret value
    // never lands in plan.json or generated files.
    const password = servicePassword(options) ?? "postgres";
    if (typeof password === "string") {
      svc.environment.POSTGRES_PASSWORD = password;
    }
    svc.environment.POSTGRES_DB = database;
  },
};
