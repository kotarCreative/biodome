import { Effect } from "effect";
import { RuntimeError } from "../../core/errors.js";
import { EventStore } from "../../core/events.js";
import {
  supportsAvailability,
  supportsBuild,
  supportsExec,
  supportsLogs,
  supportsRender,
  supportsRestart,
  supportsStart,
  supportsStatus,
  supportsStop,
} from "../../runtime/driver.js";
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
    const { driver } = operation;
    if (!supportsAvailability(driver)) return yield* unsupported(driver.id, "availability checks");
    if (!supportsRender(driver)) return yield* unsupported(driver.id, "lifecycle.build");
    if (!supportsBuild(driver)) return yield* unsupported(driver.id, "lifecycle.build");
    yield* driver.ensureAvailable(operation.target);
    yield* driver.render(operationInput(operation));
    yield* driver.build(operationInput(operation));
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
    const { driver } = operation;
    if (!supportsAvailability(driver)) return yield* unsupported(driver.id, "availability checks");
    if (!supportsStart(driver)) return yield* unsupported(driver.id, "lifecycle.start");
    yield* driver.ensureAvailable(operation.target);
    if (options.build) {
      if (!supportsRender(driver)) return yield* unsupported(driver.id, "lifecycle.build");
      if (!supportsBuild(driver)) return yield* unsupported(driver.id, "lifecycle.build");
      yield* driver.render(operationInput(operation));
      yield* driver.build(operationInput(operation));
    }
    const state = yield* driver.start(operationInput(operation));
    writeState(rootDir, targetName, state);
    yield* Effect.logInfo(`Target "${targetName}" is running`);
    if (options.wait) {
      if (!supportsStop(driver)) return yield* unsupported(driver.id, "lifecycle.stop");
      yield* Effect.logInfo("Press Ctrl+C to stop");
      yield* Effect.callback<void, never, never>((resume) => {
        process.on("SIGINT", () => resume(Effect.void));
      });
      yield* driver.stop(operationInput(operation));
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
    if (!supportsStop(operation.driver))
      return yield* unsupported(operation.driver.id, "lifecycle.stop");
    yield* operation.driver.stop(operationInput(operation));
    removeState(rootDir, targetName);
    return { message: `Target "${targetName}" stopped` };
  });
}

function unsupported(driverId: string, operation: string): RuntimeError {
  return new RuntimeError({ message: `Driver "${driverId}" does not support ${operation}` });
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
    if (!supportsExec(operation.driver))
      return yield* unsupported(operation.driver.id, "exec.command");
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
    if (!supportsLogs(operation.driver))
      return yield* unsupported(operation.driver.id, "logs.stream");
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
    if (!supportsStatus(operation.driver))
      return yield* unsupported(operation.driver.id, "status.read");
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
    if (!supportsStatus(operation.driver))
      return yield* unsupported(operation.driver.id, "status.read");
    const status = yield* operation.driver.status(operationInput(operation));
    if (operation.driver.capabilities.has("process.status") && supportsExec(operation.driver)) {
      yield* operation.driver.exec({
        ...operationInput(operation),
        command: ["supervisorctl", "-c", operation.layout.container.supervisordConfig, "status"],
      });
    }
    return {
      status,
      hasProcessStatus:
        operation.driver.capabilities.has("process.status") && supportsExec(operation.driver),
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
      if (!supportsRestart(operation.driver)) {
        return yield* unsupported(operation.driver.id, "process.signal");
      }
      yield* operation.driver.restart({ ...operationInput(operation), processName });
    } else {
      const skipped: string[] = [];
      for (const process of operation.plan.runtime.processes.filter(
        (item) => item.mode === "daemon",
      )) {
        if (!supportsRestart(operation.driver)) {
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
