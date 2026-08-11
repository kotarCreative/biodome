import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { capabilitiesOf } from "../../../core/capabilities.js";
import { RuntimeError } from "../../../core/errors.js";
import { NoOpEventStoreLive } from "../../../core/events.js";
import { createPlan } from "../../../core/plan.js";
import type { RuntimeDriver } from "../../../runtime/driver.js";
import { createTargetOperation } from "../../../cli/target-operation.js";
import {
  buildWorkflow,
  downWorkflow,
  execWorkflow,
  logsWorkflow,
  restartWorkflow,
  upWorkflow,
} from "../../../cli/workflows/target.js";
import { targetValidateWorkflow } from "../../../cli/workflows/config.js";
import { writeState } from "../../../runtime/state.js";

function driver(
  capabilities = capabilitiesOf(
    "lifecycle.build",
    "lifecycle.start",
    "lifecycle.stop",
    "status.read",
  ),
): RuntimeDriver {
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
        createdAt: "",
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

  it("validates deployment state before stopping", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "biodome-down-"));
    try {
      const stop = vi.fn(() => Effect.void);
      const runtimeDriver = driver();
      runtimeDriver.stop = stop;
      const deps = dependencies(runtimeDriver);
      await expect(Effect.runPromise(downWorkflow(rootDir, "local", deps))).rejects.toThrow(
        "No deployment state found",
      );
      expect(stop).not.toHaveBeenCalled();

      writeState(rootDir, "local", {
        driver: "fake",
        deploymentId: "deployment",
        resourceIds: {},
        createdAt: "",
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

  it("reads logs without requiring stopped deployment state or a build manifest", async () => {
    const logs = vi.fn(() => Effect.void);
    const runtimeDriver = driver(
      capabilitiesOf("lifecycle.build", "lifecycle.start", "lifecycle.stop", "logs.stream"),
    ) as RuntimeDriver & { logs: typeof logs };
    runtimeDriver.logs = logs;

    await expect(
      Effect.runPromise(
        logsWorkflow("/project", "local", undefined, dependencies(runtimeDriver)).pipe(
          Effect.provide(NoOpEventStoreLive("test")),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(logs).toHaveBeenCalledOnce();
    expect(logs.mock.calls[0][0]).not.toHaveProperty("state");
    expect(logs.mock.calls[0][0]).not.toHaveProperty("buildManifest");
  });

  it("restarts every daemon or reports them as skipped when unsupported", async () => {
    const restarted: string[] = [];
    const runtimeDriver = driver(
      capabilitiesOf("lifecycle.build", "lifecycle.start", "lifecycle.stop", "process.signal"),
    ) as RuntimeDriver & {
      restart: (input: { processName: string }) => ReturnType<typeof Effect.void>;
    };
    runtimeDriver.restart = ({ processName }) =>
      Effect.sync(() => {
        restarted.push(processName);
      });
    const deps = dependencies(runtimeDriver);
    deps.plan.runtime.processes.push(
      { name: "web", command: ["web"], ports: [], environment: {}, mode: "daemon" },
      { name: "worker", command: ["worker"], ports: [], environment: {}, mode: "daemon" },
      { name: "setup", command: ["setup"], ports: [], environment: {}, mode: "oneshot" },
    );

    const result = await Effect.runPromise(
      restartWorkflow("/project", "local", undefined, deps).pipe(
        Effect.provide(NoOpEventStoreLive("test")),
      ),
    );
    expect(result.skipped).toEqual([]);
    expect(restarted).toEqual(["web", "worker"]);
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
    const runtimeDriver: RuntimeDriver = { ...baseDriver, id: "aws-ecs", render };
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
});
