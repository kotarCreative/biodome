import type { RuntimeDriver } from "./driver.js";
import { dockerComposeDriver } from "./docker-compose.js";
import { awsEcsDriver } from "./aws-ecs.js";
import { RuntimeError } from "../core/errors.js";
import { Effect } from "effect";

const drivers = new Map<string, RuntimeDriver>();

export function registerDriver(driver: RuntimeDriver): void {
  drivers.set(driver.id, driver);
}

export function getDriver(id: string): Effect.Effect<RuntimeDriver, RuntimeError, never> {
  const driver = drivers.get(id);
  if (!driver) {
    const available = Array.from(drivers.keys()).join(", ");
    return Effect.fail(
      new RuntimeError({
        message: `Unknown runtime driver "${id}". Available drivers: ${available || "(none registered)"}`,
      }),
    );
  }
  return Effect.succeed(driver);
}

export function hasDriver(id: string): boolean {
  return drivers.has(id);
}

export function registeredDrivers(): string[] {
  return Array.from(drivers.keys());
}

// Register built-in drivers.
registerDriver(dockerComposeDriver);
registerDriver(awsEcsDriver);
