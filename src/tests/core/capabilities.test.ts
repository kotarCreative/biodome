import { describe, it, expect } from "vitest";
import { hasCapability } from "../../core/capabilities.js";
import { dockerComposeDriver } from "../../runtime/docker-compose.js";

describe("dockerComposeDriver capabilities", () => {
  const caps = dockerComposeDriver.capabilities;

  it("advertises the lifecycle and operational capabilities it supports", () => {
    expect(caps).toBeInstanceOf(Set);
    expect(hasCapability(caps, "lifecycle.build")).toBe(true);
    expect(hasCapability(caps, "lifecycle.start")).toBe(true);
    expect(hasCapability(caps, "lifecycle.stop")).toBe(true);
    expect(hasCapability(caps, "lifecycle.restart")).toBe(true);
    expect(hasCapability(caps, "exec.inplace")).toBe(true);
    expect(hasCapability(caps, "logs.stream")).toBe(true);
    expect(hasCapability(caps, "status.read")).toBe(true);
    expect(hasCapability(caps, "process.status")).toBe(true);
    expect(hasCapability(caps, "process.signal")).toBe(true);
    expect(hasCapability(caps, "volume.mount")).toBe(true);
    expect(hasCapability(caps, "artifact.collect")).toBe(true);
  });

  it("does not advertise capabilities that dockerComposeDriver does not implement", () => {
    expect(hasCapability(caps, "snapshot.create")).toBe(false);
    expect(hasCapability(caps, "snapshot.restore")).toBe(false);
    expect(hasCapability(caps, "exec.pty")).toBe(true);
    expect(hasCapability(caps, "network.policy")).toBe(false);
  });
});
