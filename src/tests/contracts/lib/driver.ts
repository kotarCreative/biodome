import { describe, expect, it } from "vitest";
import type { Capability } from "../../../core/capabilities.js";
import { RuntimeError } from "../../../core/errors.js";
import { validateRuntimeDriver, type RuntimeDriver } from "../../../runtime/driver.js";

export function runtimeDriverMetadataContract(
  implementation: string,
  driver: RuntimeDriver,
  expectedCapabilities: readonly Capability[],
): void {
  describe(`${implementation} driver metadata contract`, () => {
    it("has the registered identity, declared capabilities, and matching operations", () => {
      expect(driver.id, implementation).toBe(implementation);
      expect([...driver.capabilities].sort()).toEqual([...expectedCapabilities].sort());
      expect(() => validateRuntimeDriver(driver)).not.toThrow();
    });
  });
}

export function runtimeDriverMetadataRejectsInvalidSurfaces(): void {
  it("reports invalid operation declarations as typed runtime errors", () => {
    expect(() =>
      validateRuntimeDriver({
        id: "invalid-contract-driver",
        capabilities: new Set(["exec.inplace"]),
      }),
    ).toThrow(RuntimeError);
  });
}
