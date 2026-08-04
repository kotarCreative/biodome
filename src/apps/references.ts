import { validateTargetName } from "../core/plan.js";
import type { AppEndpointReference, AppReferenceBuilder, ServiceReference } from "./types.js";

function validateName(name: string, label: string): void {
  try {
    validateTargetName(name);
  } catch (error) {
    throw new Error(`Invalid ${label} name: ${(error as Error).message}`);
  }
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function app(name: string): AppReferenceBuilder {
  validateName(name, "app");
  return frozen({
    endpoint(endpoint = "http"): AppEndpointReference {
      validateName(endpoint, "endpoint");
      return frozen({ _tag: "AppEndpointReference", app: name, endpoint });
    },
  });
}

export function service(name: string): ServiceReference {
  validateName(name, "service");
  return frozen({ _tag: "ServiceReference", service: name });
}

export function isAppEndpointReference(value: unknown): value is AppEndpointReference {
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    (value as { _tag?: unknown })._tag === "AppEndpointReference" &&
    typeof (value as { app?: unknown }).app === "string" &&
    typeof (value as { endpoint?: unknown }).endpoint === "string"
  );
}

export function isServiceReference(value: unknown): value is ServiceReference {
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    (value as { _tag?: unknown })._tag === "ServiceReference" &&
    typeof (value as { service?: unknown }).service === "string"
  );
}
