import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { capabilitiesOf } from "../../core/capabilities.js";
import { RuntimeError } from "../../core/errors.js";
import type { RuntimeDriver } from "../../runtime/driver.js";
import { createDriverRegistry } from "../../runtime/registry.js";

function createDriver(id: string): RuntimeDriver {
  return {
    id,
    capabilities: capabilitiesOf(),
    render: () => Effect.succeed([]),
    ensureAvailable: () => Effect.void,
    build: () => Effect.succeed({}),
    start: () =>
      Effect.succeed({ driver: id, deploymentId: "test", resourceIds: {}, createdAt: "" }),
    stop: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    collectArtifacts: () => Effect.succeed([]),
    status: () => Effect.succeed({ state: "unknown" }),
    logs: () => Effect.void,
    restart: () => Effect.void,
  };
}

describe("runtime driver registry", () => {
  it("loads only the selected driver", async () => {
    const registry = createDriverRegistry();
    let selectedLoads = 0;
    let otherLoads = 0;
    registry.registerDriver("selected", async () => {
      selectedLoads++;
      return createDriver("selected");
    });
    registry.registerDriver("other", async () => {
      otherLoads++;
      return createDriver("other");
    });

    await expect(Effect.runPromise(registry.getDriver("selected"))).resolves.toMatchObject({
      id: "selected",
    });
    expect(selectedLoads).toBe(1);
    expect(otherLoads).toBe(0);
  });

  it("shares successful and in-flight loads", async () => {
    const registry = createDriverRegistry();
    let loads = 0;
    let resolveLoad!: (driver: RuntimeDriver) => void;
    registry.registerDriver(
      "shared",
      () =>
        new Promise((resolve) => {
          loads++;
          resolveLoad = resolve;
        }),
    );

    const first = Effect.runPromise(registry.getDriver("shared"));
    const second = Effect.runPromise(registry.getDriver("shared"));
    await Promise.resolve();
    expect(loads).toBe(1);
    resolveLoad(createDriver("shared"));

    const [firstDriver, secondDriver] = await Promise.all([first, second]);
    expect(firstDriver).toBe(secondDriver);
    await expect(Effect.runPromise(registry.getDriver("shared"))).resolves.toBe(firstDriver);
    expect(loads).toBe(1);
  });

  it("retries failed loads with typed runtime errors", async () => {
    const registry = createDriverRegistry();
    let loads = 0;
    registry.registerDriver("retry", async () => {
      loads++;
      if (loads === 1) throw new Error("unavailable");
      return createDriver("retry");
    });

    await expect(Effect.runPromise(registry.getDriver("retry"))).rejects.toBeInstanceOf(
      RuntimeError,
    );
    await expect(Effect.runPromise(registry.getDriver("retry"))).resolves.toMatchObject({
      id: "retry",
    });
    expect(loads).toBe(2);
  });

  it("rejects a loaded driver whose ID does not match its registration", async () => {
    const registry = createDriverRegistry();
    registry.registerDriver("expected", async () => createDriver("actual"));

    await expect(Effect.runPromise(registry.getDriver("expected"))).rejects.toMatchObject({
      _tag: "RuntimeError",
      message: 'Runtime driver "expected" loaded a driver with ID "actual"',
    });
  });

  it("reports registered IDs for unknown drivers without loading modules", async () => {
    const registry = createDriverRegistry();
    let loads = 0;
    registry.registerDriver("one", async () => {
      loads++;
      return createDriver("one");
    });
    registry.registerDriver("two", async () => {
      loads++;
      return createDriver("two");
    });

    await expect(Effect.runPromise(registry.getDriver("missing"))).rejects.toMatchObject({
      _tag: "RuntimeError",
      message: 'Unknown runtime driver "missing". Available drivers: one, two',
    });
    expect(loads).toBe(0);
    expect(registry.hasDriver("one")).toBe(true);
    expect(registry.registeredDrivers()).toEqual(["one", "two"]);
  });
});
