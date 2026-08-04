import { describe, expect, it } from "vitest";
import { app, service } from "../../apps/index.js";

describe("app references", () => {
  it("returns frozen, serializable reference values", () => {
    const endpoint = app("backend").endpoint("api");
    const database = service("postgres");
    expect(endpoint).toEqual({ _tag: "AppEndpointReference", app: "backend", endpoint: "api" });
    expect(database).toEqual({ _tag: "ServiceReference", service: "postgres" });
    expect(Object.isFrozen(endpoint)).toBe(true);
    expect(JSON.parse(JSON.stringify(endpoint))).toEqual(endpoint);
  });

  it("validates reference names", () => {
    expect(() => app("../../bad")).toThrow("Invalid app name");
    expect(() => service("")).toThrow("Invalid service name");
  });
});
