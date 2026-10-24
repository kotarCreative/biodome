import { Effect } from "effect";
import { RuntimeError } from "../../core/errors.js";
import { assertProfileManifest, assertProfileState } from "../../core/profiles.js";
import { existsSync } from "node:fs";
import { statePath } from "../../runtime/state.js";
import {
  EventStore,
  commandMetadata,
  instrumentOperation,
  type EventScope,
} from "../../core/events.js";
import {
  supportsAvailability,
  supportsBuild,
  supportsInplaceExec,
  supportsShell,
  supportsLogs,
  supportsRender,
  supportsRestart,
  supportsStart,
  supportsStatus,
  supportsStop,
  supportsTargetValidation,
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
import { providerProfile } from "../../orchestration/compiler.js";
import { preflightTargetCompatibility } from "../../orchestration/compatibility.js";

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

function operationInputWithValidatedState(operation: TargetOperation) {
  return {
    ...operationInput(operation),
    state: readState(
      operation.rootDir,
      operation.target.name,
      operation.deploymentId,
      operation.driver.id,
    ),
  };
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
    provider: {
      ...buildResult.provider,
      ...(operation.plan.profile
        ? { "biodome.profileFingerprint": operation.plan.profile.fingerprint }
        : {}),
    },
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

function ensureTargetCompatible(
  operation: TargetOperation,
): Effect.Effect<void, RuntimeError, never> {
  const compatibility = preflightTargetCompatibility(
    operation.plan,
    providerProfile(operation.driver),
  );
  if (compatibility.compatible) return Effect.void;
  const details = compatibility.missing
    .map((issue) => `${issue.subject}${issue.reason ? ` (${issue.reason})` : ""}`)
    .join(", ");
  return Effect.fail(
    new RuntimeError({
      message: `Target "${operation.target.name}" is incompatible with provider "${operation.driver.id}": ${details}`,
    }),
  );
}

function validateProviderTarget(operation: TargetOperation) {
  return supportsTargetValidation(operation.driver)
    ? operation.driver.validateTarget(operationInput(operation))
    : Effect.void;
}

export function buildWorkflow(
  rootDir: string,
  targetName: string,
  dependencies?: TargetOperationDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* createTargetOperation(rootDir, targetName, {}, dependencies);
    yield* planLoaded(operation, targetName);
    yield* ensureTargetCompatible(operation);
    yield* validateProviderTarget(operation);
    const { driver } = operation;
    if (!supportsAvailability(driver)) return yield* unsupported(driver.id, "availability checks");
    if (!supportsRender(driver)) return yield* unsupported(driver.id, "lifecycle.build");
    if (!supportsBuild(driver)) return yield* unsupported(driver.id, "lifecycle.build");
    yield* driver.ensureAvailable(operation.target);
    yield* driver.render(operationInput(operation));
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: operation.target.name,
      provider: driver.id,
    };
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
    const scopedTarget = operation.target.name;
    if (operation.plan.profile && existsSync(statePath(rootDir, scopedTarget)))
      yield* assertProfileState(
        operation.plan,
        readState(rootDir, scopedTarget, operation.deploymentId, operation.driver.id),
      );
    yield* planLoaded(operation, targetName);
    yield* ensureTargetCompatible(operation);
    yield* validateProviderTarget(operation);
    const { driver } = operation;
    if (!supportsAvailability(driver)) return yield* unsupported(driver.id, "availability checks");
    if (!supportsStart(driver)) return yield* unsupported(driver.id, "lifecycle.start");
    yield* driver.ensureAvailable(operation.target);
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: operation.target.name,
      provider: driver.id,
    };
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
    yield* assertProfileManifest(operation.plan, manifest);
    const state = yield* instrumentOperation(
      store,
      scope,
      "start",
      { rootDir, build: options.build ?? false },
      driver.start({ ...operationInput(operation), buildManifest: manifest }),
    );
    writeState(rootDir, scopedTarget, {
      ...state,
      profileFingerprint: operation.plan.profile?.fingerprint,
    });
    const validated = readState(rootDir, scopedTarget, operation.deploymentId, driver.id);
    yield* Effect.sync(() => console.log(`Target "${targetName}" is running`));
    if (options.wait) {
      if (!supportsStop(driver)) return yield* unsupported(driver.id, "lifecycle.stop");
      yield* Effect.sync(() => console.log("Press Ctrl+C to stop"));
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
      removeState(rootDir, scopedTarget);
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
    const state = readState(
      rootDir,
      operation.target.name,
      operation.deploymentId,
      operation.driver.id,
    );
    if (!supportsStop(operation.driver))
      return yield* unsupported(operation.driver.id, "lifecycle.stop");
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: operation.target.name,
      provider: operation.driver.id,
    };
    yield* instrumentOperation(
      store,
      scope,
      "stop",
      { rootDir },
      operation.driver.stop({ ...operationInput(operation), state }),
    );
    removeState(rootDir, operation.target.name);
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
      target: operation.target.name,
      provider: operation.driver.id,
    };
    // `biodome exec` is in-place execution by contract. One-shot jobs belong
    // to named task runs, which select the job path through the orchestrator.
    if (!supportsInplaceExec(operation.driver)) {
      return yield* unsupported(operation.driver.id, "in-place command execution");
    }
    const input = operationInputWithState(operation);
    yield* assertProfileState(operation.plan, input.state);
    yield* assertProfileManifest(operation.plan, input.buildManifest);
    const result = yield* instrumentOperation(
      store,
      scope,
      "exec",
      commandMetadata(command),
      operation.driver.exec({ ...input, command }),
    );
    yield* Effect.sync(() => {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    });
    if (result.exitCode !== 0 || result.timedOut) {
      return yield* new RuntimeError({
        message: result.timedOut
          ? "Command timed out"
          : `Command failed with exit code ${result.exitCode}`,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });
    }
    return { message: `Command completed on target "${targetName}"` };
  }).pipe(Effect.scoped);
}

export function shellWorkflow(
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
    if (!supportsShell(operation.driver)) {
      return yield* unsupported(operation.driver.id, "interactive shells");
    }
    const input = operationInputWithState(operation);
    yield* assertProfileState(operation.plan, input.state);
    yield* assertProfileManifest(operation.plan, input.buildManifest);
    yield* operation.driver.shell(input);
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
      target: operation.target.name,
      provider: operation.driver.id,
    };
    yield* instrumentOperation(
      store,
      scope,
      "logs",
      { processName },
      operation.driver.logs({ ...operationInputWithValidatedState(operation), processName }),
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
    const store = yield* EventStore;
    const scope: EventScope = {
      runId: store.runId,
      target: operation.target.name,
      provider: operation.driver.id,
    };
    const status = yield* instrumentOperation(
      store,
      scope,
      "status",
      {},
      operation.driver.status(operationInputWithValidatedState(operation)),
    );
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
      target: operation.target.name,
      provider: operation.driver.id,
    };
    const status = yield* instrumentOperation(
      store,
      scope,
      "status",
      {},
      operation.driver.status(input),
    );
    let processStatus: string | undefined;
    if (
      operation.driver.capabilities.has("process.status") &&
      supportsInplaceExec(operation.driver)
    ) {
      const result = yield* instrumentOperation(
        store,
        scope,
        "exec",
        {
          ...commandMetadata([
            "supervisorctl",
            "-c",
            operation.layout.container.supervisordConfig,
            "status",
          ]),
        },
        operation.driver.exec({
          ...input,
          command: ["supervisorctl", "-c", operation.layout.container.supervisordConfig, "status"],
        }),
      );
      processStatus = result.stdout || result.stderr;
    }
    return {
      status,
      ...(processStatus ? { processStatus } : {}),
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
      yield* assertProfileState(operation.plan, operationInputWithValidatedState(operation).state);
      if (!supportsRestart(operation.driver)) {
        return yield* unsupported(operation.driver.id, "process.signal");
      }
      const store = yield* EventStore;
      const scope: EventScope = {
        runId: store.runId,
        target: operation.target.name,
        provider: operation.driver.id,
      };
      yield* instrumentOperation(
        store,
        scope,
        "restart",
        { processName },
        operation.driver.restart({ ...operationInputWithValidatedState(operation), processName }),
      );
    } else {
      const skipped: string[] = [];
      const input = operationInputWithValidatedState(operation);
      yield* assertProfileState(operation.plan, input.state);
      const store = yield* EventStore;
      const scope: EventScope = {
        runId: store.runId,
        target: operation.target.name,
        provider: operation.driver.id,
      };
      for (const process of operation.plan.runtime.processes.filter(
        (item) => item.mode === "daemon",
      )) {
        if (!supportsRestart(operation.driver)) {
          skipped.push(process.name);
          yield* Effect.sync(() =>
            console.error(
              `Driver "${operation.driver.id}" does not support process.signal, skipping ${process.name}`,
            ),
          );
          continue;
        }
        yield* instrumentOperation(
          store,
          scope,
          "restart",
          { processName: process.name },
          operation.driver.restart({ ...input, processName: process.name }),
        );
      }
      return { message: `Restart completed on target "${targetName}"`, skipped };
    }
    return { message: `Restart completed on target "${targetName}"`, skipped: [] };
  }).pipe(Effect.scoped);
}
