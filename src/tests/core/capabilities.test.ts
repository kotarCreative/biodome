import { describe, it, expect } from "vitest";
import { DockerRuntime } from "../../docker/runner.js";
import { hasCapability } from "../../core/capabilities.js";

describe("DockerRuntime capabilities", () => {
  it("advertises the lifecycle and operational capabilities it supports", () => {
    const runtime = new DockerRuntime("test-project");

    expect(runtime.capabilities).toBeInstanceOf(Set);
    expect(hasCapability(runtime.capabilities, "lifecycle.build")).toBe(true);
    expect(hasCapability(runtime.capabilities, "lifecycle.start")).toBe(true);
    expect(hasCapability(runtime.capabilities, "lifecycle.stop")).toBe(true);
    expect(hasCapability(runtime.capabilities, "lifecycle.restart")).toBe(true);
    expect(hasCapability(runtime.capabilities, "exec.command")).toBe(true);
    expect(hasCapability(runtime.capabilities, "logs.stream")).toBe(true);
    expect(hasCapability(runtime.capabilities, "status.read")).toBe(true);
    expect(hasCapability(runtime.capabilities, "process.signal")).toBe(true);
  });

  it("does not advertise capabilities that DockerRuntime does not implement", () => {
    const runtime = new DockerRuntime("test-project");

    expect(hasCapability(runtime.capabilities, "snapshot.create")).toBe(false);
    expect(hasCapability(runtime.capabilities, "snapshot.restore")).toBe(false);
    expect(hasCapability(runtime.capabilities, "exec.pty")).toBe(false);
    expect(hasCapability(runtime.capabilities, "network.policy")).toBe(false);
    expect(hasCapability(runtime.capabilities, "volume.mount")).toBe(false);
  });
});
