import { describe, expect, it } from "vitest";
import {
  canTransitionRun,
  createRunRecord,
  transitionRun,
} from "../../orchestration/run-record.js";

describe("run records", () => {
  it("starts in planned and has a constrained lifecycle", () => {
    const run = createRunRecord({
      task: "review",
      target: "local",
      provider: "docker-sandbox",
      planDigest: "abc",
      runId: "run-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(run.status).toBe("planned");
    expect(canTransitionRun("planned", "preparing")).toBe(true);
    expect(canTransitionRun("complete", "executing")).toBe(false);
  });

  it("rejects skipped lifecycle transitions", () => {
    const run = createRunRecord({
      task: "review",
      target: "local",
      provider: "docker-sandbox",
      planDigest: "abc",
    });
    expect(() => transitionRun(run, "executing")).toThrow("planned -> executing");
  });

  it("records the start and completion timestamps", () => {
    let run = createRunRecord({
      task: "review",
      target: "local",
      provider: "docker-sandbox",
      planDigest: "abc",
    });
    run = transitionRun(run, "preparing", "2026-01-01T00:00:00.000Z");
    run = transitionRun(run, "ready", "2026-01-01T00:01:00.000Z");
    run = transitionRun(run, "executing", "2026-01-01T00:02:00.000Z");
    run = transitionRun(run, "succeeded", "2026-01-01T00:03:00.000Z");
    run = transitionRun(run, "complete", "2026-01-01T00:04:00.000Z");
    expect(run.startedAt).toBe("2026-01-01T00:02:00.000Z");
    expect(run.completedAt).toBe("2026-01-01T00:04:00.000Z");
  });
});
