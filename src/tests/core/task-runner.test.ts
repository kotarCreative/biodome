import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  executeTask,
  actionCommand,
  shouldRunCleanup,
  type TaskResult,
} from "../../core/task-runner.js";
import { Plan, createPlan } from "../../core/plan.js";
import type {
  RuntimeDriver,
  RenderableDriver,
  AvailableDriver,
  BuildableDriver,
  StartableDriver,
  StoppableDriver,
  ExecutableDriver,
  JobDriver,
  ArtifactDriver,
  StatusDriver,
  CommandResult,
  Artifact,
  DeploymentState,
  StatusResult,
} from "../../runtime/driver.js";
import { capabilitiesOf } from "../../core/capabilities.js";
import { EventStore } from "../../core/events.js";
import { RuntimeError } from "../../core/errors.js";
import { targetBuildDir } from "../../runtime/output.js";
import { writeState } from "../../runtime/state.js";
import { writeBuildManifest } from "../../runtime/build-manifest.js";

function fakeEventStore(): EventStore {
  return {
    runId: "test",
    emit: () => Effect.void,
    events: () => Effect.succeed([]),
    close: () => Effect.void,
  };
}

/** Full driver surface executeTask may exercise on a task-capable backend. */
type TestDriver = RuntimeDriver &
  RenderableDriver &
  AvailableDriver &
  BuildableDriver &
  StartableDriver &
  StoppableDriver &
  ExecutableDriver &
  ArtifactDriver &
  StatusDriver;

function createFakeDriver(overrides?: Partial<TestDriver>): TestDriver {
  return {
    id: "fake-driver",
    capabilities: capabilitiesOf(
      "lifecycle.build",
      "lifecycle.start",
      "lifecycle.stop",
      "status.read",
      "exec.inplace",
      "artifact.collect",
    ),
    render: () => Effect.succeed([]),
    ensureAvailable: () => Effect.void,
    build: () => Effect.succeed({ imageRef: "fake:image" }),
    start: () =>
      Effect.succeed<DeploymentState>({
        driver: "fake-driver",
        deploymentId: "test-deploy",
        resourceIds: {},
        createdAt: new Date().toISOString(),
      }),
    stop: () => Effect.void,
    exec: () =>
      Effect.succeed<CommandResult>({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 100,
      }),
    collectArtifacts: () =>
      Effect.succeed<Artifact[]>([
        { path: "review.md", sizeBytes: 42, localPath: "/tmp/artifacts/review.md" },
      ]),
    status: () => Effect.succeed<StatusResult>({ state: "running" }),
    ...overrides,
  };
}

function planWithTask(options?: {
  cleanup?: "always" | "on-success" | "never";
  artifacts?: string[];
  deploymentId?: string;
  taskName?: string;
  timeout?: string;
}): Plan {
  const plan = createPlan("test-project");
  plan.deployment = {
    target: { name: "local", driver: "docker-compose", options: {} },
    deploymentId: options?.deploymentId ?? "test-deploy",
    task: {
      name: options?.taskName ?? "review-pr",
      command: ["npm", "test"],
      intent: "Review the code",
      input: {},
      artifacts: options?.artifacts ?? ["review.md"],
      timeout: options?.timeout ?? "5m",
      cleanup: options?.cleanup ?? "always",
    },
  };
  return plan;
}

function setupStateFile(rootDir: string, plan: Plan): void {
  const targetName = plan.deployment!.target.name;
  const dir = targetBuildDir(rootDir, targetName);
  mkdirSync(dir, { recursive: true });
  writeState(rootDir, targetName, {
    driver: "fake-driver",
    deploymentId: plan.deployment!.deploymentId,
    createdAt: new Date().toISOString(),
    resourceIds: {},
  });
  writeBuildManifest(rootDir, targetName, {
    schemaVersion: 1,
    target: targetName,
    driver: "fake-driver",
    deploymentId: plan.deployment!.deploymentId,
    imageRef: `sha256:${"a".repeat(64)}`,
    digest: `sha256:${"a".repeat(64)}`,
    contentId: "fake-content",
    createdAt: new Date().toISOString(),
    provider: {},
  });
}

describe("actionCommand", () => {
  it("passes intent, inputs, and outputs as data without shell interpolation", () => {
    const task = planWithTask().deployment!.task!;
    task.input = { route: "$(touch /tmp/should-not-exist)", users: 5 };
    expect(actionCommand(task)).toEqual([
      "env",
      "BIODOME_ACTION_NAME=review-pr",
      "BIODOME_ACTION_INTENT=Review the code",
      `BIODOME_ACTION_INPUT=${JSON.stringify(task.input)}`,
      'BIODOME_ACTION_OUTPUTS=["review.md"]',
      "npm",
      "test",
    ]);
  });
});

describe("executeTask", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = join(tmpdir(), `task-runner-test-${randomUUID()}`);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function runTask(
    driver: RuntimeDriver,
    plan: Plan,
  ): Effect.Effect<TaskResult, RuntimeError, never> {
    return executeTask(rootDir, plan, driver).pipe(
      Effect.provideService(EventStore, fakeEventStore()),
    );
  }

  it("runs a task to completion and collects artifacts", async () => {
    const driver = createFakeDriver();
    const plan = planWithTask();
    const result = await Effect.runPromise(runTask(driver, plan));
    expect(result.exitCode).toBe(0);
    const artifacts = result.artifacts;
    expect(artifacts).toBeDefined();
    if (artifacts === undefined) throw new Error("expected artifacts to be collected");
    expect(artifacts[0].path).toBe("review.md");
  });

  it("keeps available failure evidence before cleanup without hiding the original exit code", async () => {
    const order: string[] = [];
    const plan = planWithTask({ artifacts: ["missing.png", "review.md"] });
    const driver = createFakeDriver({
      exec: () =>
        Effect.succeed({ exitCode: 7, stdout: "failed assertion", stderr: "", durationMs: 1 }),
      collectArtifacts: (input) => {
        order.push(input.paths[0]);
        expect(input.artifactDir).toContain("artifacts/test");
        return input.paths[0] === "missing.png"
          ? Effect.fail(new RuntimeError({ message: "Screenshot unavailable" }))
          : Effect.succeed([{ path: "review.md", sizeBytes: 42, localPath: "/tmp/review.md" }]);
      },
      stop: () =>
        Effect.sync(() => {
          order.push("stop");
        }),
    });
    setupStateFile(rootDir, plan);
    const result = await Effect.runPromise(Effect.result(runTask(driver, plan)));
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected failed QA");
    expect(result.failure.exitCode).toBe(7);
    expect(result.failure.message).toContain("exit code 7");
    expect(result.failure.artifacts?.map((artifact) => artifact.path)).toEqual(["review.md"]);
    expect(order).toEqual(["missing.png", "review.md", "stop"]);
  });

  it("exposes cleanup failures independently of a successful QA outcome", async () => {
    const plan = planWithTask();
    setupStateFile(rootDir, plan);
    const result = await Effect.runPromise(
      runTask(
        createFakeDriver({
          stop: () => Effect.fail(new RuntimeError({ message: "Provider refused cleanup" })),
        }),
        plan,
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.cleanupFailed).toBe(true);
  });

  it("executes validation commands after the agent", async () => {
    const execFn = vi
      .fn()
      .mockReturnValue(
        Effect.succeed<CommandResult>({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      );
    const plan = planWithTask({ artifacts: [] });
    plan.deployment!.task!.validationCommands = [
      ["npm", "test"],
      ["npm", "run", "lint"],
    ];
    await Effect.runPromise(runTask(createFakeDriver({ exec: execFn }), plan));
    expect(execFn).toHaveBeenCalledTimes(3);
    expect(execFn.mock.calls[1][0].command).toEqual(["npm", "test"]);
    expect(execFn.mock.calls[2][0].command).toEqual(["npm", "run", "lint"]);
  });

  it("passes validation commands into one provider-native job", async () => {
    const runJob = vi
      .fn()
      .mockReturnValue(
        Effect.succeed<CommandResult>({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      );
    const plan = planWithTask({ artifacts: ["review.md"] });
    plan.deployment!.task!.validationCommands = [
      ["npm", "test"],
      ["npm", "run", "lint"],
    ];
    const driver = {
      ...createFakeDriver(),
      capabilities: capabilitiesOf(
        "lifecycle.build",
        "lifecycle.start",
        "lifecycle.stop",
        "status.read",
        "job.run",
        "artifact.collect",
      ),
      runJob,
    } satisfies TestDriver & JobDriver;

    await Effect.runPromise(runTask(driver, plan));

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactPaths: ["review.md"],
        validationCommands: [
          ["npm", "test"],
          ["npm", "run", "lint"],
        ],
      }),
    );
  });

  it("reuses a running deployment", async () => {
    const statusFn = vi.fn().mockReturnValue(Effect.succeed<StatusResult>({ state: "running" }));
    const driver = createFakeDriver({ status: statusFn });
    const plan = planWithTask();
    setupStateFile(rootDir, plan);

    await Effect.runPromise(runTask(driver, plan));
    expect(statusFn).toHaveBeenCalled();
  });

  it("rebuilds when status is not running", async () => {
    const statusFn = vi.fn().mockReturnValue(Effect.succeed<StatusResult>({ state: "stopped" }));
    const stopFn = vi.fn().mockReturnValue(Effect.void);
    const buildFn = vi.fn().mockReturnValue(Effect.succeed({}));
    const renderFn = vi.fn().mockReturnValue(Effect.succeed([]));
    const startFn = vi.fn().mockReturnValue(
      Effect.succeed<DeploymentState>({
        driver: "fake-driver",
        deploymentId: planWithTask().deployment!.deploymentId,
        resourceIds: {},
        createdAt: new Date().toISOString(),
      }),
    );
    const driver = createFakeDriver({
      status: statusFn,
      stop: stopFn,
      build: buildFn,
      render: renderFn,
      start: startFn,
    });
    const plan = planWithTask();
    setupStateFile(rootDir, plan);

    await Effect.runPromise(runTask(driver, plan));
    expect(statusFn).toHaveBeenCalled();
    expect(stopFn).toHaveBeenCalled();
    expect(buildFn).toHaveBeenCalled();
  });

  it("fails before runtime calls if exec.inplace is missing", async () => {
    const renderFn = vi.fn().mockReturnValue(Effect.succeed([]));
    const execFn = vi.fn().mockReturnValue(
      Effect.succeed({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
    );
    const driver = createFakeDriver({
      capabilities: capabilitiesOf(
        "lifecycle.build",
        "lifecycle.start",
        "lifecycle.stop",
        "artifact.collect",
      ),
      render: renderFn,
      exec: execFn,
    });
    const plan = planWithTask();
    await expect(Effect.runPromise(runTask(driver, plan))).rejects.toThrow(
      /Driver "fake-driver" does not support/,
    );
    expect(renderFn).not.toHaveBeenCalled();
    expect(execFn).not.toHaveBeenCalled();
  });

  it("fails before runtime calls if artifact.collect is missing for declared artifacts", async () => {
    const driver = createFakeDriver({
      capabilities: capabilitiesOf(
        "lifecycle.build",
        "lifecycle.start",
        "lifecycle.stop",
        "status.read",
        "exec.inplace",
      ),
    });
    const plan = planWithTask({ artifacts: ["review.md"] });
    await expect(Effect.runPromise(runTask(driver, plan))).rejects.toThrow(
      /does not support artifact collection/,
    );
  });

  it("fails before runtime calls when required lifecycle capabilities are missing", async () => {
    const render = vi.fn().mockReturnValue(Effect.succeed([]));
    const driver = createFakeDriver({
      capabilities: capabilitiesOf("exec.inplace", "artifact.collect"),
      render,
    });
    await expect(Effect.runPromise(runTask(driver, planWithTask()))).rejects.toThrow(
      /does not support lifecycle.build and lifecycle.start/,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("runs an OpenCode task via its generated task wrapper", async () => {
    const execFn = vi.fn().mockReturnValue(
      Effect.succeed<CommandResult>({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 10,
      }),
    );
    const driver = createFakeDriver({
      capabilities: capabilitiesOf(
        "lifecycle.build",
        "lifecycle.start",
        "lifecycle.stop",
        "status.read",
        "exec.inplace",
        "artifact.collect",
      ),
      exec: execFn,
      start: () =>
        Effect.succeed({
          driver: "fake-driver",
          deploymentId: "test",
          resourceIds: {},
          createdAt: new Date().toISOString(),
        }),
    });
    const plan = createPlan("test-project");
    plan.deployment = {
      target: { name: "local", driver: "docker-compose", options: {} },
      deploymentId: "test",
      task: {
        name: "t",
        command: ["npm", "test"],
        intent: "Check the branch",
        input: {},
        artifacts: [],
        timeout: "1m",
        cleanup: "always",
      },
    };
    const result = await Effect.runPromise(runTask(driver, plan));
    expect(result.exitCode).toBe(0);
    expect(execFn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.arrayContaining(["npm", "test"]),
      }),
    );
  });

  it("succeeds with required task operations and no artifact support for an artifact-free task", async () => {
    const driver = createFakeDriver({
      capabilities: capabilitiesOf(
        "lifecycle.build",
        "lifecycle.start",
        "lifecycle.stop",
        "status.read",
        "exec.inplace",
      ),
    });
    const plan = planWithTask({ artifacts: [] });
    const result = await Effect.runPromise(runTask(driver, plan));
    expect(result.exitCode).toBe(0);
    expect(result.artifacts).toBeUndefined();
  });

  it("passes the task timeout to exec in milliseconds", async () => {
    const execFn = vi.fn().mockReturnValue(
      Effect.succeed<CommandResult>({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 10,
      }),
    );
    const plan = planWithTask({ artifacts: [], timeout: "30s" });

    await Effect.runPromise(runTask(createFakeDriver({ exec: execFn }), plan));

    expect(execFn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000, artifactPaths: [] }),
    );
  });

  it("emits exactly one task.failed event when exec times out", async () => {
    const emitted: string[] = [];
    const store: EventStore = {
      ...fakeEventStore(),
      emit: (type) =>
        Effect.sync(() => {
          emitted.push(type);
        }),
    };
    const driver = createFakeDriver({
      exec: () =>
        Effect.succeed({
          exitCode: 124,
          stdout: "",
          stderr: "",
          durationMs: 1_000,
          timedOut: true,
        }),
    });
    const plan = planWithTask({ artifacts: [], cleanup: "never", timeout: "1s" });
    const effect = executeTask(rootDir, plan, driver).pipe(
      Effect.provideService(EventStore, store),
    );

    await expect(Effect.runPromise(effect)).rejects.toThrow(/timed out after 1s/);
    expect(emitted.filter((type) => type === "task.failed")).toHaveLength(1);
    expect(emitted).not.toContain("task.completed");
  });
});

describe("shouldRunCleanup", () => {
  it("always cleans up regardless of exit code", () => {
    expect(shouldRunCleanup("always", 0)).toBe(true);
    expect(shouldRunCleanup("always", 1)).toBe(true);
  });

  it("cleans up on success only for a zero exit code", () => {
    expect(shouldRunCleanup("on-success", 0)).toBe(true);
    expect(shouldRunCleanup("on-success", 1)).toBe(false);
  });

  it("never cleans up when cleanup is disabled", () => {
    expect(shouldRunCleanup("never", 0)).toBe(false);
    expect(shouldRunCleanup("never", 1)).toBe(false);
  });
});
