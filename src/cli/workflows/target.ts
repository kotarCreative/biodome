import { Effect } from "effect";
import { RuntimeError } from "../../core/errors.js";
import { EventStore, instrumentOperation, type EventScope } from "../../core/events.js";
import {
  supportsAvailability,
  supportsBuild,
  supportsInplaceExec,
  supportsJob,
  supportsLogs,
  supportsRender,
  supportsRestart,
  supportsStart,
  supportsStatus,
  supportsStop,
} from "../../runtime/driver.js";
import { readState, removeState, writeState } from "../../runtime/state.js";
import {
  manifestFromBuildResult,
  writeBuildManifest,
  readBuildManifest,
  type BuildManifest,
} from "../../runtime/build-manifest.js";
import {
  createTargetOperation,
  type TargetOperation,
  type TargetOperationDependencies,
  operationInput,
} from "../target-operation.js";

/** Pass validated deployment state and the durable build manifest to an operation. */
function operationInputWithState(operation: TargetOperation) {
  const state = readState(
    operation.rootDir,
    operation.target.name,
    operation.deploymentId,
    operation.driver.id,
  );
  const buildManifest = readBuildManifest(
    operation.rootDir,
    operation.target.name,
    operation.deploymentId,
    operation.driver.id,
  );
  return { ...operationInput(operation), state, buildManifest };
}

function persistBuildManifest(
  operation: TargetOperation,
  buildResult: { imageRef?: string; digest?: string; provider?: Readonly<Record<string, string>> },
): BuildManifest {
  const manifest = manifestFromBuildResult({
    rootDir: operation.rootDir,
    targetName: operation.target.name,
    driver: operation.driver.id,
    deploymentId: operation.deploymentId,
    buildResult,
    contentId: buildResult.digest ?? operation.deploymentId,
    provider: buildResult.provider,
  });
  writeBuildManifest(operation.rootDir, operation.target.name, manifest);
  return manifest;
}

function readCurrentBuildManifest(operation: TargetOperation): BuildManifest | undefined {
  try {
    return readBuildManifest(
      operation.rootDir,
      operation.target.name,
      operation.deploymentId,
      operation.driver.id,
    );
  } catch {
    return undefined;
  }
}

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
    const store = yield* EventStore;
    const scope: EventScope = { runId: store.runId, target: targetName, provider: driver.id };
    const buildResult = yield* instrumentOperation(
      store,
      scope,
      "build",
      { rootDir },
      driver.build(operationInput(operation)),
    );
    persistBuildManifest(operation, buildResult);
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
    const store = yield* EventStore;
    const scope: EventScope = { runId: store.runId, target: targetName, provider: driver.id };
    let buildManifest: BuildManifest | undefined = readCurrentBuildManifest(operation);
    if (options.build) {
      if (!supportsRender(driver)) return yield* unsupported(driver.id, "lifecycle.build");
      if (!supportsBuild(driver)) return yield* unsupported(driver.id, "lifecycle.build");
      yield* driver.render(operationInput(operation));
      const buildResult = yield* instrumentOperation(
        store,
        scope,
        "build",
        { rootDir },
        driver.build(operationInput(operation)),
      );
      buildManifest = persistBuildManifest(operation, buildResult);
    }
    const manifest =
      buildManifest ??
      (yield* new RuntimeError({
        message: `No build manifest found for target "${targetName}". Run "biodome build ${targetName}" first.`,
      }));
    const state = yield* instrumentOperation(
      store,
      scope,
      "start",
      { rootDir, build: options.build ?? false },
      driver.start({ ...operationInput(operation), buildManifest: manifest }),
    );
    writeState(rootDir, targetName, state);
    const validated = readState(rootDir, targetName, operation.deploymentId, driver.id);
    yield* Effect.logInfo(`Target "${targetName}" is running`);
    if (options.wait) {
      if (!supportsStop(driver)) return yield* unsupported(driver.id, "lifecycle.stop");
      yield* Effect.logInfo("Press Ctrl+C to stop");
      yield* Effect.callback<void, never, never>((resume) => {
        process.on("SIGINT", () => resume(Effect.void));
      });
      yield* instrumentOperation(
        store,
        scope,
        "stop",
        { rootDir },
        driver.stop({ ...operationInput(operation), state: validated }),
      );
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
    const state = readState(rootDir, targetName, operation.deploymentId, operation.driver.id);
    if (!supportsStop(operation.driver))
      return yield* unsupported(operation.driver.id, "lifecycle.stop");
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: targetName,
      provider: operation.driver.id,
    };
    yield* instrumentOperation(
      store,
      scope,
      "stop",
      { rootDir },
      operation.driver.stop({ ...operationInput(operation), state }),
    );
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
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: targetName,
      provider: operation.driver.id,
    };
    if (supportsJob(operation.driver)) {
      const input = operationInputWithState(operation);
      yield* instrumentOperation(
        store,
        scope,
        "job",
        { command },
        operation.driver.runJob({ ...input, command }),
      );
    } else if (supportsInplaceExec(operation.driver)) {
      const input = operationInputWithState(operation);
      yield* instrumentOperation(
        store,
        scope,
        "exec",
        { command },
        operation.driver.exec({ ...input, command }),
      );
    } else {
      return yield* unsupported(operation.driver.id, "command execution");
    }
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
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: targetName,
      provider: operation.driver.id,
    };
    yield* instrumentOperation(
      store,
      scope,
      "logs",
      { processName },
      operation.driver.logs({ ...operationInput(operation), processName }),
    );
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
    const status = yield* operation.driver.status(operationInputWithState(operation));
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
    const input = operationInputWithState(operation);
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: targetName,
      provider: operation.driver.id,
    };
    const status = yield* instrumentOperation(
      store,
      scope,
      "status",
      {},
      operation.driver.status(input),
    );
    if (
      operation.driver.capabilities.has("process.status") &&
      supportsInplaceExec(operation.driver)
    ) {
      yield* instrumentOperation(
        store,
        scope,
        "exec",
        {
          command: ["supervisorctl", "-c", operation.layout.container.supervisordConfig, "status"],
        },
        operation.driver.exec({
          ...input,
          command: ["supervisorctl", "-c", operation.layout.container.supervisordConfig, "status"],
        }),
      );
    }
    return {
      status,
      hasProcessStatus:
        operation.driver.capabilities.has("process.status") &&
        supportsInplaceExec(operation.driver),
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
      const store = yield* EventStore;
      const scope: EventScope = {
        runId: store.runId,
        target: targetName,
        provider: operation.driver.id,
      };
      yield* instrumentOperation(
        store,
        scope,
        "restart",
        { processName },
        operation.driver.restart({ ...operationInput(operation), processName }),
      );
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
        const store = yield* EventStore;
        const scope: EventScope = {
          runId: store.runId,
          target: targetName,
          provider: operation.driver.id,
        };
        yield* instrumentOperation(
          store,
          scope,
          "restart",
          { processName: process.name },
          operation.driver.restart({
            ...operationInput(operation),
            processName: process.name,
          }),
        );
      }
      return { message: `Restart completed on target "${targetName}"`, skipped };
    }
    return { message: `Restart completed on target "${targetName}"`, skipped: [] };
  }).pipe(Effect.scoped);
}
