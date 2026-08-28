import type { SecretArnReference, SecretReference } from "./secrets.js";
import type { PostgresExtensionName, Service } from "./plan.js";
import { ServiceOptions } from "./feature.js";

// The container environment variable carrying the service credential. The
// generated init scripts read it at run time; it is never baked into files.
export const POSTGRES_PASSWORD_ENV_VAR = "POSTGRES_PASSWORD";

export const POSTGRES_EXTENSION_PACKAGES: Record<PostgresExtensionName, readonly string[]> = {
  citext: ["postgresql-contrib"],
  hstore: ["postgresql-contrib"],
  ltree: ["postgresql-contrib"],
  pg_trgm: ["postgresql-contrib"],
  pgcrypto: ["postgresql-contrib"],
  postgis: ["postgresql-postgis"],
  postgis_raster: ["postgresql-postgis"],
  postgis_topology: ["postgresql-postgis"],
  unaccent: ["postgresql-contrib"],
  "uuid-ossp": ["postgresql-contrib"],
};

// The declared credential for a service: users[0].password, falling back to
// the top-level options.password.
export function servicePassword(
  options: ServiceOptions,
): string | SecretReference | SecretArnReference | undefined {
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
    if (options.extensions && options.extensions.length > 0) {
      svc.extensions = [...options.extensions];
    }
  },
};
