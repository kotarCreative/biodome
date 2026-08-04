import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { createPlan, type Plan } from "../../core/plan.js";
import { capabilitiesOf } from "../../core/capabilities.js";
import type { RuntimeDriver } from "../../runtime/driver.js";
import { EventStore, type EventStore as EventStoreService } from "../../core/events.js";
import { orchestrateTask } from "../../orchestration/orchestrator.js";
import { readRunRecord } from "../../orchestration/run-store.js";

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
  plan.runtime.piHarnesses.push({
    name: "agent",
    type: "pi",
    telemetry: { enabled: false, path: "" },
    config: {},
  });
  plan.deployment = {
    target: { name: "local", driver: "fake", options: {} },
    deploymentId: "orchestration-test-local",
    task: {
      name: "review",
      harness: "agent",
      prompt: "Review this project",
      artifacts: ["review.md"],
      timeout: "1m",
      cleanup: "always",
    },
  };
  return plan;
}

function driver(): RuntimeDriver {
  return {
    id: "fake",
    capabilities: capabilitiesOf("exec.command", "artifact.collect"),
    render: () => Effect.succeed([]),
    ensureAvailable: () => Effect.void,
    build: () => Effect.succeed({}),
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
    logs: () => Effect.void,
    restart: () => Effect.void,
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
    expect(readRunRecord(rootDir, "local", result.run.runId).status).toBe("complete");
  });

  it("rejects incompatible providers before provisioning", async () => {
    const base = driver();
    const start = vi.fn(base.start);
    const incompatible: RuntimeDriver = {
      ...base,
      capabilities: capabilitiesOf("exec.command"),
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
});
