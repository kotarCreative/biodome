import { Effect } from "effect";
import { RuntimeError } from "../core/errors.js";
import { validateRuntimeDriver, type RuntimeDriver } from "./driver.js";

export type DriverLoader = () => Promise<RuntimeDriver>;

interface DriverRecord {
  loader: DriverLoader;
  driver?: RuntimeDriver;
  loading?: Promise<RuntimeDriver>;
}

export interface RuntimeDriverRegistry {
  registerDriver(id: string, loader: DriverLoader): void;
  getDriver(id: string): Effect.Effect<RuntimeDriver, RuntimeError, never>;
  hasDriver(id: string): boolean;
  registeredDrivers(): string[];
}

export function createDriverRegistry(): RuntimeDriverRegistry {
  const drivers = new Map<string, DriverRecord>();

  function registerDriver(id: string, loader: DriverLoader): void {
    drivers.set(id, { loader });
  }

  function getDriver(id: string): Effect.Effect<RuntimeDriver, RuntimeError, never> {
    const record = drivers.get(id);
    if (!record) {
      const available = Array.from(drivers.keys()).join(", ");
      return Effect.fail(
        new RuntimeError({
          message: `Unknown runtime driver "${id}". Available drivers: ${available || "(none registered)"}`,
        }),
      );
    }

    if (record.driver) return Effect.succeed(record.driver);

    return Effect.tryPromise({
      try: () => {
        if (!record.loading) {
          const loading = Promise.resolve()
            .then(record.loader)
            .then((driver) => {
              if (driver.id !== id) {
                throw new RuntimeError({
                  message: `Runtime driver "${id}" loaded a driver with ID "${driver.id}"`,
                });
              }
              validateRuntimeDriver(driver);
              record.driver = driver;
              return driver;
            });
          record.loading = loading;
          void loading.then(undefined, () => {
            // Failed imports must be retried rather than becoming a permanent cached failure.
            if (record.loading === loading) record.loading = undefined;
          });
        }
        return record.loading;
      },
      catch: (error) =>
        error instanceof RuntimeError
          ? error
          : new RuntimeError({ message: `Failed to load runtime driver "${id}"` }),
    });
  }

  function hasDriver(id: string): boolean {
    return drivers.has(id);
  }

  function registeredDrivers(): string[] {
    return Array.from(drivers.keys());
  }

  return { registerDriver, getDriver, hasDriver, registeredDrivers };
}

const registry = createDriverRegistry();

export const registerDriver = registry.registerDriver;
export const getDriver = registry.getDriver;
export const hasDriver = registry.hasDriver;
export const registeredDrivers = registry.registeredDrivers;

// Register built-ins by ID without evaluating their provider SDKs.
registerDriver("docker-compose", () =>
  import("./docker-compose.js").then(({ dockerComposeDriver }) => dockerComposeDriver),
);
registerDriver("aws-ecs", () => import("./aws-ecs.js").then(({ awsEcsDriver }) => awsEcsDriver));
registerDriver("docker-sandbox", () =>
  import("./docker-sandbox.js").then(({ dockerSandboxDriver }) => dockerSandboxDriver),
);
