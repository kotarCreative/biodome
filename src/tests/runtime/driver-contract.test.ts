import { describe, expect, it } from "vitest";
import { createAwsEcsDriver } from "../../runtime/aws-ecs.js";
import { dockerComposeDriver } from "../../runtime/docker-compose.js";
import { dockerSandboxDriver } from "../../runtime/docker-sandbox.js";
import { capabilitiesOf } from "../../core/capabilities.js";
import { supportsInplaceExec, supportsJob, validateRuntimeDriver } from "../../runtime/driver.js";
import {
  runtimeDriverMetadataContract,
  runtimeDriverMetadataRejectsInvalidSurfaces,
} from "../contracts/lib/driver.js";

describe("runtime driver contracts", () => {
  runtimeDriverMetadataRejectsInvalidSurfaces();
});

runtimeDriverMetadataContract("docker-compose", dockerComposeDriver, [
  "lifecycle.build",
  "lifecycle.start",
  "lifecycle.stop",
  "lifecycle.restart",
  "exec.inplace",
  "exec.pty",
  "logs.stream",
  "status.read",
  "process.status",
  "process.signal",
  "volume.mount",
  "artifact.collect",
]);

runtimeDriverMetadataContract("docker-sandbox", dockerSandboxDriver, [
  "lifecycle.build",
  "lifecycle.start",
  "lifecycle.stop",
  "exec.inplace",
  "process.signal",
  "logs.stream",
  "status.read",
  "volume.mount",
  "artifact.collect",
]);

runtimeDriverMetadataContract("aws-ecs", createAwsEcsDriver(), [
  "lifecycle.build",
  "lifecycle.start",
  "lifecycle.stop",
  "status.read",
  "logs.stream",
  "job.run",
  "artifact.collect",
]);

describe("in-place exec and one-shot job contracts", () => {
  const drivers = [dockerComposeDriver, dockerSandboxDriver, createAwsEcsDriver()];

  it("enforces capability/method agreement for exec and jobs independently", () => {
    expect(() =>
      validateRuntimeDriver({
        id: "exec-without-method",
        capabilities: capabilitiesOf("exec.inplace"),
      }),
    ).toThrow(/declares exec.inplace but does not implement exec/);
    expect(() =>
      validateRuntimeDriver({
        id: "job-without-method",
        capabilities: capabilitiesOf("job.run"),
      }),
    ).toThrow(/declares job.run but does not implement runJob/);
  });

  it("keeps every built-in driver on exactly one command execution path", () => {
    for (const driver of drivers) {
      expect(supportsInplaceExec(driver)).toBe(driver.capabilities.has("exec.inplace"));
      expect(supportsJob(driver)).toBe(driver.capabilities.has("job.run"));
      expect(
        supportsInplaceExec(driver) && supportsJob(driver),
        `driver "${driver.id}" must not expose both execution paths`,
      ).toBe(false);
    }
  });

  it("gives local providers in-place execution and remote providers jobs", () => {
    expect(supportsInplaceExec(dockerComposeDriver)).toBe(true);
    expect(supportsInplaceExec(dockerSandboxDriver)).toBe(true);
    expect(supportsJob(dockerComposeDriver)).toBe(false);
    expect(supportsJob(dockerSandboxDriver)).toBe(false);
    const ecs = createAwsEcsDriver();
    expect(supportsJob(ecs)).toBe(true);
    expect(supportsInplaceExec(ecs)).toBe(false);
  });
});
