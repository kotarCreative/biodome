import { Effect } from "effect";
import type {
  RuntimeDriver,
  RuntimeOperationInput,
  BuildResult,
  DeploymentState,
  CommandResult,
  Artifact,
} from "./driver.js";
import type { RuntimeTarget } from "../core/plan.js";
import { RuntimeError } from "../core/errors.js";
import { capabilitiesOf } from "../core/capabilities.js";
import type { EventStore } from "../core/events.js";

function notYetImplemented(method: string): RuntimeError {
  return new RuntimeError({
    message: `aws-ecs driver does not yet implement "${method}". The Docker Compose driver is available for local targets.`,
  });
}

export const awsEcsDriver: RuntimeDriver = {
  id: "aws-ecs",

  capabilities: capabilitiesOf(
    "lifecycle.build",
    "lifecycle.start",
    "lifecycle.stop",
    "status.read",
  ),

  render(_input: {
    rootDir: string;
    outputDir: string;
    plan: any;
    target: RuntimeTarget;
  }): Effect.Effect<string[], RuntimeError, never> {
    return Effect.fail(notYetImplemented("render"));
  },

  ensureAvailable(): Effect.Effect<void, RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("ensureAvailable"));
  },

  build(_input: RuntimeOperationInput): Effect.Effect<BuildResult, RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("build"));
  },

  start(_input: RuntimeOperationInput): Effect.Effect<DeploymentState, RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("start"));
  },

  stop(_input: RuntimeOperationInput): Effect.Effect<void, RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("stop"));
  },

  exec(
    _input: RuntimeOperationInput & { command: string[] },
  ): Effect.Effect<CommandResult, RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("exec"));
  },

  collectArtifacts(
    _input: RuntimeOperationInput & { paths: string[] },
  ): Effect.Effect<Artifact[], RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("collectArtifacts"));
  },

  status(
    _input: RuntimeOperationInput,
  ): Effect.Effect<{ state: string; message?: string }, RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("status"));
  },

  logs(
    _input: RuntimeOperationInput & { processName?: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("logs"));
  },

  restart(
    _input: RuntimeOperationInput & { processName: string },
  ): Effect.Effect<void, RuntimeError, EventStore> {
    return Effect.fail(notYetImplemented("restart"));
  },
};
