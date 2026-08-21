import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { capabilitiesOf } from "../../../core/capabilities.js";
import { RuntimeError } from "../../../core/errors.js";
import { NoOpEventStoreLive } from "../../../core/events.js";
import { createPlan } from "../../../core/plan.js";
import type {
  AvailableDriver,
  BuildableDriver,
  ExecutableDriver,
  RenderableDriver,
  RestartDriver,
  RuntimeDriver,
  StartableDriver,
  StatusDriver,
  StoppableDriver,
} from "../../../runtime/driver.js";
import { createTargetOperation } from "../../../cli/target-operation.js";
import {
  buildWorkflow,
  downWorkflow,
  execWorkflow,
  logsWorkflow,
  psWorkflow,
  restartWorkflow,
  statusWorkflow,
  upWorkflow,
} from "../../../cli/workflows/target.js";
import { targetValidateWorkflow } from "../../../cli/workflows/config.js";
import { createBuildManifest, writeBuildManifest } from "../../../runtime/build-manifest.js";
import { writeState } from "../../../runtime/state.js";

type TestDriver = RuntimeDriver &
  RenderableDriver &
  AvailableDriver &
  BuildableDriver &
  StartableDriver &
  StoppableDriver &
  ExecutableDriver &
  StatusDriver;

function driver(
  capabilities = capabilitiesOf(
    "lifecycle.build",
    "lifecycle.start",
    "lifecycle.stop",
    "status.read",
  ),
): TestDriver {
  return {
    id: "fake",
    capabilities,
    render: () => Effect.succeed([]),
    ensureAvailable: () => Effect.void,
    build: () => Effect.succeed({ imageRef: "fake:image" }),
    start: () =>
      Effect.succeed({
        driver: "fake",
        deploymentId: "deployment",
        resourceIds: {},
        createdAt: new Date().toISOString(),
      }),
    stop: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    status: () => Effect.succeed({ state: "unknown" }),
  };
}

function dependencies(runtimeDriver = driver()) {
  const plan = createPlan("project");
  plan.deployment = {
    target: { name: "local", driver: "fake", options: {} },
    deploymentId: "deployment",
  };
  return {
    plan,
    buildTargetPlan: vi.fn(() => Effect.succeed(plan)),
    getDriver: vi.fn(() => Effect.succeed(runtimeDriver)),
  };
}

describe("target workflows", () => {
  it("assembles target operations through the injected registry", async () => {
    const deps = dependencies();
    const operation = await Effect.runPromise(
      createTargetOperation("/project", "local", { dryRun: true }, deps),
    );
    expect(deps.buildTargetPlan).toHaveBeenCalledWith("/project", "local", { dryRun: true });
    expect(deps.getDriver).toHaveBeenCalledWith("fake");
    expect(operation.layout.host.root).toBe("/project/.biodome-build/targets/local");
    expect(operation.deploymentId).toBe("deployment");
  });

  it("build ensures, renders, then builds", async () => {
    const runtimeDriver = driver();
    const order: string[] = [];
    runtimeDriver.ensureAvailable = () =>
      Effect.sync(() => {
        order.push("ensure");
      });
    runtimeDriver.render = () =>
      Effect.sync(() => {
        order.push("render");
        return [];
      });
    runtimeDriver.build = () =>
      Effect.sync(() => {
        order.push("build");
        return {};
      });
    const rootDir = mkdtempSync(join(tmpdir(), "biodome-build-"));
    try {
      await Effect.runPromise(
        buildWorkflow(rootDir, "local", dependencies(runtimeDriver)).pipe(
          Effect.provide(NoOpEventStoreLive("test")),
        ),
      );
      expect(order).toEqual(["ensure", "render", "build"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported local target requirements before availability checks", async () => {
    const runtimeDriver = { ...driver(), id: "docker-compose" };
    const ensureAvailable = vi.fn(() => Effect.void);
    runtimeDriver.ensureAvailable = ensureAvailable;
    const deps = dependencies(runtimeDriver);
    deps.plan.deployment!.target.driver = "docker-compose";
    deps.plan.runtime.services.push({
      name: "redis",
      type: "redis",
      runtime: "process",
      image: "redis:7",
      containerName: "redis",
      environment: {},
      ports: [],
      volumes: [],
      networks: [],
    });

    const rootDir = mkdtempSync(join(tmpdir(), "biodome-preflight-"));
    try {
      await expect(
        Effect.runPromise(
          buildWorkflow(rootDir, "local", deps).pipe(Effect.provide(NoOpEventStoreLive("test"))),
        ),
      ).rejects.toThrow(/incompatible with provider/);
      expect(ensureAvailable).not.toHaveBeenCalled();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("up builds when requested and preserves exec capability errors", async () => {
    const runtimeDriver = driver();
    const build = vi.fn(() => Effect.succeed({ imageRef: "fake:image" }));
    runtimeDriver.build = build;
    await Effect.runPromise(
      upWorkflow("/tmp", "local", { build: true }, dependencies(runtimeDriver)).pipe(
        Effect.provide(NoOpEventStoreLive("test")),
      ),
    );
    expect(build).toHaveBeenCalledOnce();
    await expect(
      Effect.runPromise(
        execWorkflow("/project", "local", ["true"], dependencies(driver())).pipe(
          Effect.provide(NoOpEventStoreLive("test")),
        ),
      ),
    ).rejects.toBeInstanceOf(RuntimeError);
  });

  it("keeps biodome exec on the in-place path and never launches one-shot jobs", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "biodome-exec-"));
    try {
      writeState(rootDir, "local", {
        driver: "fake",
        deploymentId: "deployment",
        resourceIds: {},
        createdAt: new Date().toISOString(),
      });
      const digest = `sha256:${"a".repeat(64)}`;
      writeBuildManifest(
        rootDir,
        "local",
        createBuildManifest({
          target: "local",
          driver: "fake",
          deploymentId: "deployment",
          digest,
          contentId: digest,
        }),
      );

      const runJob = vi.fn(() =>
        Effect.succeed({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
      );
      const jobOnly = {
        ...driver(capabilitiesOf("lifecycle.build", "lifecycle.start")),
        id: "fake-job",
        capabilities: capabilitiesOf("job.run"),
        runJob,
      } as unknown as TestDriver;
      await expect(
        Effect.runPromise(
          execWorkflow(rootDir, "local", ["true"], dependencies(jobOnly)).pipe(
            Effect.provide(NoOpEventStoreLive("test")),
          ),
        ),
      ).rejects.toThrow(/in-place command execution/);
      expect(runJob).not.toHaveBeenCalled();

      const exec = vi.fn(() =>
        Effect.succeed({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
      );
      const inPlace = {
        ...driver(capabilitiesOf("lifecycle.build", "lifecycle.start")),
        capabilities: capabilitiesOf("exec.inplace"),
        exec,
      };
      await Effect.runPromise(
        execWorkflow(rootDir, "local", ["true"], dependencies(inPlace)).pipe(
          Effect.provide(NoOpEventStoreLive("test")),
        ),
      );
      expect(exec).toHaveBeenCalledOnce();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("validates deployment state before stopping", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "biodome-down-"));
    try {
      const stop = vi.fn(() => Effect.void);
      const runtimeDriver = driver();
      runtimeDriver.stop = stop;
      const deps = dependencies(runtimeDriver);
      await expect(
        Effect.runPromise(
          downWorkflow(rootDir, "local", deps).pipe(Effect.provide(NoOpEventStoreLive("test"))),
        ),
      ).rejects.toThrow("No deployment state found");
      expect(stop).not.toHaveBeenCalled();

      writeState(rootDir, "local", {
        driver: "fake",
        deploymentId: "deployment",
        resourceIds: {},
        createdAt: new Date().toISOString(),
      });
      await expect(
        Effect.runPromise(
          downWorkflow(rootDir, "local", deps).pipe(Effect.provide(NoOpEventStoreLive("test"))),
        ),
      ).resolves.toEqual({ message: 'Target "local" stopped' });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("requires validated deployment state before reading logs", async () => {
    const logs = vi.fn(() => Effect.void);
    const runtimeDriver = driver(
      capabilitiesOf("lifecycle.build", "lifecycle.start", "lifecycle.stop", "logs.stream"),
    ) as TestDriver & { logs: typeof logs };
    runtimeDriver.logs = logs;

    await expect(
      Effect.runPromise(
        logsWorkflow("/project", "local", undefined, dependencies(runtimeDriver)).pipe(
          Effect.provide(NoOpEventStoreLive("test")),
        ),
      ),
    ).rejects.toThrow("No deployment state found");
    expect(logs).not.toHaveBeenCalled();
  });

  it("restarts every daemon or reports them as skipped when unsupported", async () => {
    const restarted: string[] = [];
    const runtimeDriver = driver(
      capabilitiesOf("lifecycle.build", "lifecycle.start", "lifecycle.stop", "process.signal"),
    ) as TestDriver & RestartDriver;
    runtimeDriver.restart = ({ processName }) =>
      Effect.sync(() => {
        restarted.push(processName);
      });
    const deps = dependencies(runtimeDriver);
    deps.plan.runtime.processes.push(
      {
        name: "web",
        command: ["web"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
      },
      {
        name: "worker",
        command: ["worker"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
      },
      {
        name: "setup",
        command: ["setup"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.post",
      },
    );

    const rootDir = mkdtempSync(join(tmpdir(), "biodome-restart-"));
    try {
      writeState(rootDir, "local", {
        driver: "fake",
        deploymentId: "deployment",
        resourceIds: {},
        createdAt: new Date().toISOString(),
      });
      const result = await Effect.runPromise(
        restartWorkflow(rootDir, "local", undefined, deps).pipe(
          Effect.provide(NoOpEventStoreLive("test")),
        ),
      );
      expect(result.skipped).toEqual([]);
      expect(restarted).toEqual(["web", "worker"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported target services during validation before driver operations", async () => {
    const plan = createPlan("project");
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      image: "postgres:17",
      containerName: "postgres",
      environment: {},
      ports: [],
      volumes: [],
      networks: [],
    });
    plan.deployment = {
      target: { name: "remote", driver: "aws-ecs", options: {} },
      deploymentId: "deployment",
    };
    const baseDriver = driver();
    const render = vi.fn(baseDriver.render);
    const runtimeDriver = { ...baseDriver, id: "aws-ecs", render };
    const deps = {
      plan,
      buildTargetPlan: vi.fn(() => Effect.succeed(plan)),
      getDriver: vi.fn(() => Effect.succeed(runtimeDriver)),
    };

    await expect(Effect.runPromise(targetValidateWorkflow("/tmp", "remote", deps))).rejects.toThrow(
      /incompatible with provider/,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("reads status through the injected driver for ps and status workflows", async () => {
    const runtimeDriver = driver();
    const status = vi.fn(() =>
      Effect.succeed({ state: "running" as const, message: "all healthy" }),
    );
    runtimeDriver.status = status;
    const deps = dependencies(runtimeDriver);

    const rootDir = mkdtempSync(join(tmpdir(), "biodome-ps-"));
    try {
      writeState(rootDir, "local", {
        driver: "fake",
        deploymentId: "deployment",
        resourceIds: {},
        createdAt: new Date().toISOString(),
      });
      writeBuildManifest(
        rootDir,
        "local",
        createBuildManifest({
          target: "local",
          driver: "fake",
          deploymentId: "deployment",
          digest: `sha256:${"a".repeat(64)}`,
          contentId: `sha256:${"a".repeat(64)}`,
        }),
      );
      await expect(
        Effect.runPromise(
          psWorkflow(rootDir, "local", deps).pipe(Effect.provide(NoOpEventStoreLive("test"))),
        ),
      ).resolves.toEqual({ status: { state: "running", message: "all healthy" } });

      const result = await Effect.runPromise(
        statusWorkflow(rootDir, "local", deps).pipe(Effect.provide(NoOpEventStoreLive("test"))),
      );
      expect(result.status).toEqual({ state: "running", message: "all healthy" });
      expect(result.hasProcessStatus).toBe(false);
      expect(status).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects ps and status for drivers without status.read", async () => {
    const runtimeDriver = driver(capabilitiesOf());
    const deps = dependencies(runtimeDriver);
    await expect(
      Effect.runPromise(
        psWorkflow("/project", "local", deps).pipe(Effect.provide(NoOpEventStoreLive("test"))),
      ),
    ).rejects.toThrow('Driver "fake" does not support status.read');
    await expect(
      Effect.runPromise(
        statusWorkflow("/project", "local", deps).pipe(Effect.provide(NoOpEventStoreLive("test"))),
      ),
    ).rejects.toThrow('Driver "fake" does not support status.read');
  });
});
