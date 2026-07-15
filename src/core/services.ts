import { Service } from "./plan.js";
import { ServiceOptions } from "./feature.js";

export const serviceConfigs: Record<string, (svc: Service, options: ServiceOptions) => void> = {
  postgres: (svc, options) => {
    const user = options.users?.[0]?.name || "postgres";
    const password = options.users?.[0]?.password || "postgres";
    const database = options.databases?.[0]?.name || "postgres";
    svc.environment.POSTGRES_USER = user;
    svc.environment.POSTGRES_PASSWORD = password;
    svc.environment.POSTGRES_DB = database;
    svc.volumes.push({ host: `${svc.name}_data`, container: "/var/lib/postgresql/data" });
    svc.healthCheck = {
      test: ["CMD-SHELL", `pg_isready -U ${user} -d ${database}`],
      interval: "5s",
      timeout: "3s",
      retries: 10,
    };
  },
  redis: (svc, options) => {
    if (options.password) {
      svc.environment.REDIS_PASSWORD = options.password;
    }
    svc.volumes.push({ host: `${svc.name}_data`, container: "/data" });
    const test = options.password
      ? `redis-cli ping | grep -q PONG`
      : "redis-cli ping | grep -q PONG";
    svc.healthCheck = {
      test: ["CMD-SHELL", test],
      interval: "5s",
      timeout: "3s",
      retries: 10,
    };
  },
};

export const defaultImages: Record<string, string> = {
  postgres: "postgres:16-alpine",
  redis: "redis:7-alpine",
  mysql: "mysql:8",
  mongo: "mongo:7",
};

export function defaultImage(name: string): string {
  return defaultImages[name] ?? name;
}
