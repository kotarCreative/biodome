import { Effect } from "effect";
import { hasCapability } from "../../core/capabilities.js";
import { RuntimeError } from "../../core/errors.js";
import { EventStore } from "../../core/events.js";
import type { Capabilities, Capability } from "../../core/capabilities.js";
import { readState, removeState, writeState } from "../../runtime/state.js";
import {
  createTargetOperation,
  type TargetOperationDependencies,
  operationInput,
} from "../target-operation.js";

function planLoaded(
  operation: {
    plan: {
      project: string;
      build: { languageRequests: { name: string }[] };
      runtime: { services: { name: string }[]; processes: { name: string }[] };
    };
  },
  targetName: string,
) {
  return Effect.gen(function* () {
    const store = yield* EventStore;
    yield* store.emit("plan.loaded", {
      project: operation.plan.project,
      languages: operation.plan.build.languageRequests.map((language) => language.name),
      services: operation.plan.runtime.services.map((service) => service.name),
      processes: operation.plan.runtime.processes.map((process) => process.name),
      ...(targetName ? { target: targetName } : {}),
    });
  });
}

export function buildWorkflow(
  rootDir: string,
  targetName: string,
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(rootDir, targetName, {}, dependencies);
    yield* planLoaded(operation, targetName);
    yield* operation.driver.ensureAvailable(operation.target);
    yield* operation.driver.render(operationInput(operation));
    yield* operation.driver.build(operationInput(operation));
    return { message: `Target "${targetName}" built` };
  });
}

export function upWorkflow(
  rootDir: string,
  targetName: string,
  options: { readonly build?: boolean; readonly wait?: boolean },
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(rootDir, targetName, {}, dependencies);
    yield* planLoaded(operation, targetName);
    yield* operation.driver.ensureAvailable(operation.target);
    if (options.build) {
      yield* operation.driver.render(operationInput(operation));
      yield* operation.driver.build(operationInput(operation));
    }
    const state = yield* operation.driver.start(operationInput(operation));
    writeState(rootDir, targetName, state);
    yield* Effect.logInfo(`Target "${targetName}" is running`);
    if (options.wait) {
      yield* Effect.logInfo("Press Ctrl+C to stop");
      yield* Effect.callback<void, never, never>((resume) => {
        process.on("SIGINT", () => resume(Effect.void));
      });
      yield* operation.driver.stop(operationInput(operation));
      removeState(rootDir, targetName);
    }
    return { message: `Target "${targetName}" is running`, waiting: Boolean(options.wait) };
  }).pipe(Effect.scoped);
}

export function downWorkflow(
  rootDir: string,
  targetName: string,
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(
      rootDir,
      targetName,
      { dryRun: true },
      dependencies,
    );
    readState(rootDir, targetName, operation.deploymentId, operation.driver.id);
    yield* operation.driver.stop(operationInput(operation));
    removeState(rootDir, targetName);
    return { message: `Target "${targetName}" stopped` };
  });
}

function requireCapability(
  operation: { driver: { id: string; capabilities: Capabilities } },
  capability: Capability,
) {
  if (!hasCapability(operation.driver.capabilities, capability)) {
    return new RuntimeError({
      message: `Driver "${operation.driver.id}" does not support ${capability}`,
    });
  }
  return undefined;
}

export function execWorkflow(
  rootDir: string,
  targetName: string,
  command: string[],
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(rootDir, targetName, {}, dependencies);
    yield* planLoaded(operation, targetName);
    const error = requireCapability(operation, "exec.command");
    if (error) return yield* error;
    yield* operation.driver.exec({ ...operationInput(operation), command });
    return { message: `Command completed on target "${targetName}"` };
  }).pipe(Effect.scoped);
}

export function logsWorkflow(
  rootDir: string,
  targetName: string,
  processName?: string,
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(
      rootDir,
      targetName,
      { dryRun: true },
      dependencies,
    );
    const error = requireCapability(operation, "logs.stream");
    if (error) return yield* error;
    yield* operation.driver.logs({ ...operationInput(operation), processName });
  }).pipe(Effect.scoped);
}

export function psWorkflow(
  rootDir: string,
  targetName: string,
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(
      rootDir,
      targetName,
      { dryRun: true },
      dependencies,
    );
    const error = requireCapability(operation, "status.read");
    if (error) return yield* error;
    const status = yield* operation.driver.status(operationInput(operation));
    return { status };
  });
}

export function statusWorkflow(
  rootDir: string,
  targetName: string,
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(
      rootDir,
      targetName,
      { dryRun: true },
      dependencies,
    );
    const error = requireCapability(operation, "status.read");
    if (error) return yield* error;
    const status = yield* operation.driver.status(operationInput(operation));
    if (hasCapability(operation.driver.capabilities, "process.status")) {
      yield* operation.driver.exec({
        ...operationInput(operation),
        command: ["supervisorctl", "-c", operation.layout.container.supervisordConfig, "status"],
      });
    }
    return {
      status,
      hasProcessStatus: hasCapability(operation.driver.capabilities, "process.status"),
    };
  }).pipe(Effect.scoped);
}

export function restartWorkflow(
  rootDir: string,
  targetName: string,
  processName?: string,
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(rootDir, targetName, {}, dependencies);
    yield* planLoaded(operation, targetName);
    if (processName) {
      const error = requireCapability(operation, "process.signal");
      if (error) return yield* error;
      yield* operation.driver.restart({ ...operationInput(operation), processName });
    } else {
      const skipped: string[] = [];
      for (const process of operation.plan.runtime.processes.filter(
        (item) => item.mode === "daemon",
      )) {
        if (!hasCapability(operation.driver.capabilities, "process.signal")) {
          skipped.push(process.name);
          yield* Effect.logWarning(
            `Driver "${operation.driver.id}" does not support process.signal, skipping ${process.name}`,
          );
          continue;
        }
        yield* operation.driver.restart({
          ...operationInput(operation),
          processName: process.name,
        });
      }
      return { message: `Restart completed on target "${targetName}"`, skipped };
    }
    return { message: `Restart completed on target "${targetName}"`, skipped: [] };
  }).pipe(Effect.scoped);
}
