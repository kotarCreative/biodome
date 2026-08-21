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
    svc.healthCheck = {
      test: ["CMD-SHELL", `pg_isready -U ${user} -d ${database}`],
      interval: "5s",
      timeout: "3s",
      retries: 10,
    };
  },
  redis: (svc, _options) => {
    svc.volumes.push({ host: `${svc.name}_data`, container: "/data" });
    svc.healthCheck = {
      test: ["CMD-SHELL", "redis-cli ping | grep -q PONG"],
      interval: "5s",
      timeout: "3s",
      retries: 10,
    };
  },
};

export const defaultImages: Record<string, string> = {
  postgres: "postgresql (in-container)",
  redis: "redis:7-alpine",
};

export function defaultImage(name: string): string {
  return defaultImages[name] ?? name;
}
