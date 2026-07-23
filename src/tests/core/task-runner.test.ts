import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { executeTask, harnessTaskCommand } from "../../core/task-runner.js";
import { Plan, createPlan } from "../../core/plan.js";
import type {
  RuntimeDriver,
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

function fakeEventStore(): EventStore {
  return {
    runId: "test",
    emit: () => Effect.void,
    events: () => Effect.succeed([]),
    close: () => Effect.void,
  };
}

function createFakeDriver(overrides?: Partial<RuntimeDriver>): RuntimeDriver {
  return {
    id: "fake-driver",
    capabilities: capabilitiesOf(
      "lifecycle.build",
      "lifecycle.start",
      "lifecycle.stop",
      "exec.command",
      "artifact.collect",
    ),
    render: () => Effect.succeed([]),
    ensureAvailable: () => Effect.void,
    build: () => Effect.succeed({}),
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
    logs: () => Effect.void,
    restart: () => Effect.void,
    ...overrides,
  };
}

function planWithTask(options?: {
  cleanup?: "always" | "on-success" | "never";
  artifacts?: string[];
  harness?: string;
  deploymentId?: string;
  taskName?: string;
  timeout?: string;
}): Plan {
  const plan = createPlan("test-project");
  plan.runtime.piHarnesses.push({
    name: options?.harness ?? "reviewer",
    type: "pi",
    telemetry: { enabled: false, path: "" },
    config: {},
  });
  plan.deployment = {
    target: { name: "local", driver: "docker-compose", options: {} },
    deploymentId: options?.deploymentId ?? "test-deploy",
    task: {
      name: options?.taskName ?? "review-pr",
      harness: options?.harness ?? "reviewer",
      prompt: "Review the code",
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
}

describe("harnessTaskCommand", () => {
  it("returns Pi task wrapper path for Pi harness", () => {
    const plan = planWithTask({ harness: "reviewer" });
    const cmd = harnessTaskCommand(plan, "reviewer", "Review the code");
    expect(cmd[0]).toBe("/workspace/.biodome-build/targets/local/pi-homes/reviewer/task");
    expect(cmd[1]).toBe("Review the code");
  });

  it("rejects OpenCode harness with actionable error", () => {
    const plan = createPlan("test-project");
    plan.runtime.agentHarnesses.push({
      name: "my-agent",
      type: "opencode",
      port: 3002,
      mcpServers: {},
      telemetry: { enabled: false, path: "" },
      config: {},
    });
    plan.deployment = {
      target: { name: "local", driver: "docker-compose", options: {} },
      deploymentId: "test",
      task: {
        name: "t",
        harness: "my-agent",
        prompt: "p",
        artifacts: [],
        timeout: "1m",
        cleanup: "always",
      },
    };
    expect(() => harnessTaskCommand(plan, "my-agent", "p")).toThrow(RuntimeError);
    expect(() => harnessTaskCommand(plan, "my-agent", "p")).toThrow(/not yet supported/);
  });

  it("throws when harness not found", () => {
    const plan = planWithTask({ harness: "reviewer" });
    expect(() => harnessTaskCommand(plan, "nonexistent", "p")).toThrow(/not found/);
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

  function runTask(driver: RuntimeDriver, plan: Plan): Effect.Effect<unknown, RuntimeError, never> {
    return executeTask(rootDir, plan, driver).pipe(
      Effect.provideService(EventStore, fakeEventStore()),
    );
  }

  it("runs a task to completion and collects artifacts", async () => {
    const driver = createFakeDriver();
    const plan = planWithTask();
    const result = (await Effect.runPromise(runTask(driver, plan))) as any;
    expect(result.exitCode).toBe(0);
    expect(result.artifacts).toBeDefined();
    expect(result.artifacts[0].path).toBe("review.md");
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

  it("fails before runtime calls if exec.command is missing", async () => {
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
        "exec.command",
      ),
    });
    const plan = planWithTask({ artifacts: ["review.md"] });
    await expect(Effect.runPromise(runTask(driver, plan))).rejects.toThrow(
      /does not support artifact collection/,
    );
  });

  it("fails before runtime calls if OpenCode task is detected", async () => {
    const driver = createFakeDriver({
      capabilities: capabilitiesOf(
        "lifecycle.build",
        "lifecycle.start",
        "lifecycle.stop",
        "exec.command",
        "artifact.collect",
      ),
    });
    const plan = createPlan("test-project");
    plan.runtime.agentHarnesses.push({
      name: "my-agent",
      type: "opencode",
      port: 3002,
      mcpServers: {},
      telemetry: { enabled: false, path: "" },
      config: {},
    });
    plan.deployment = {
      target: { name: "local", driver: "docker-compose", options: {} },
      deploymentId: "test",
      task: {
        name: "t",
        harness: "my-agent",
        prompt: "p",
        artifacts: [],
        timeout: "1m",
        cleanup: "always",
      },
    };
    await expect(Effect.runPromise(runTask(driver, plan))).rejects.toThrow(/not yet supported/);
  });

  it("succeeds with a driver that has only exec.command for an artifact-free task", async () => {
    const driver = createFakeDriver({
      capabilities: capabilitiesOf(
        "lifecycle.build",
        "lifecycle.start",
        "lifecycle.stop",
        "exec.command",
      ),
    });
    const plan = planWithTask({ artifacts: [] });
    const result = (await Effect.runPromise(runTask(driver, plan))) as any;
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

    expect(execFn).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
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
