import { describe } from "vitest";
import { createAwsEcsDriver } from "../../runtime/aws-ecs.js";
import { dockerComposeDriver } from "../../runtime/docker-compose.js";
import { dockerSandboxDriver } from "../../runtime/docker-sandbox.js";
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
  "exec.pty",
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
