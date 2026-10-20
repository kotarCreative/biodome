import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { createPlan, type Plan } from "../../core/plan.js";
import { capabilitiesOf } from "../../core/capabilities.js";
import type {
  RuntimeDriver,
  RenderableDriver,
  AvailableDriver,
  BuildableDriver,
  StartableDriver,
  StoppableDriver,
  ExecutableDriver,
  ArtifactDriver,
  StatusDriver,
} from "../../runtime/driver.js";
import { EventStore, type EventStore as EventStoreService } from "../../core/events.js";
import { orchestrateTask } from "../../orchestration/orchestrator.js";
import { readRunRecordEffect } from "../../orchestration/run-store.js";

function eventStore(): EventStoreService {
  return {
    runId: "test",
    emit: () => Effect.void,
    events: () => Effect.succeed([]),
    close: () => Effect.void,
  };
}

function taskPlan(): Plan {
  const plan = createPlan("orchestration-test");
  plan.deployment = {
    target: { name: "local", driver: "fake", options: {} },
    deploymentId: "orchestration-test-local",
    task: {
      name: "review",
      command: ["npm", "test"],
      intent: "Review this project",
      input: {},
      artifacts: ["review.md"],
      timeout: "1m",
      cleanup: "always",
      workspace: { strategy: "clone" },
    },
  };
  return plan;
}

/** Full driver surface orchestrateTask may exercise on a task-capable backend. */
type TestDriver = RuntimeDriver &
  RenderableDriver &
  AvailableDriver &
  BuildableDriver &
  StartableDriver &
  StoppableDriver &
  ExecutableDriver &
  ArtifactDriver &
  StatusDriver;

function driver(): TestDriver {
  return {
    id: "fake",
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
      Effect.succeed({
        driver: "fake",
        deploymentId: "orchestration-test-local",
        resourceIds: {},
        createdAt: new Date().toISOString(),
      }),
    stop: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
    collectArtifacts: (input) =>
      Effect.succeed(
        input.paths.map((path) => ({ path, sizeBytes: 12, localPath: `/tmp/${path}` })),
      ),
    status: () => Effect.succeed({ state: "running" }),
  };
}

describe("orchestrateTask", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = join(tmpdir(), `biodome-orchestrator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it("preflights, executes, collects artifacts, and persists a completed run", async () => {
    const result = await Effect.runPromise(
      orchestrateTask(rootDir, taskPlan(), driver()).pipe(
        Effect.provideService(EventStore, eventStore()),
      ),
    );
    expect(result.run.status).toBe("complete");
    expect(result.run.artifacts[0]).toMatchObject({ path: "review.md", sizeBytes: 12 });
    expect(
      (await Effect.runPromise(readRunRecordEffect(rootDir, "local", result.run.runId))).status,
    ).toBe("complete");
  });

  it("rejects incompatible providers before provisioning", async () => {
    const base = driver();
    const start = vi.fn(base.start);
    const incompatible: TestDriver = {
      ...base,
      capabilities: capabilitiesOf("exec.inplace"),
      start,
    };
    const outcome = await Effect.runPromise(
      orchestrateTask(rootDir, taskPlan(), incompatible).pipe(
        Effect.provideService(EventStore, eventStore()),
        Effect.match({
          onFailure: (error) => ({ ok: false, error }),
          onSuccess: (result) => ({ ok: true, result }),
        }),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("maps missing run records to RuntimeError", async () => {
    await expect(
      Effect.runPromise(readRunRecordEffect(rootDir, "local", "missing")),
    ).rejects.toMatchObject({
      _tag: "RuntimeError",
      message: expect.stringContaining("Run record not found"),
    });
  });
});
