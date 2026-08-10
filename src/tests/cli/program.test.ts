import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../../cli/program.js";

describe("CLI program parsing", () => {
  it("passes build target arguments to the build workflow", async () => {
    const build = vi.fn(() => Effect.succeed({ message: "built" }));
    const run = vi.fn(async (effect) => {
      await Effect.runPromise(effect);
    });
    const program = createProgram({ rootDir: () => "/project", run, workflows: { build } });
    await program.parseAsync(["node", "biodome", "--no-events", "build", "demo"]);
    expect(build).toHaveBeenCalledWith("/project", "demo");
    expect(run).toHaveBeenCalledOnce();
  });

  it("passes up options to the up workflow", async () => {
    const up = vi.fn(() => Effect.succeed({ message: "running", waiting: false }));
    const run = vi.fn(async (effect) => {
      await Effect.runPromise(effect);
    });
    const program = createProgram({ rootDir: () => "/project", run, workflows: { up } });
    await program.parseAsync(["node", "biodome", "--no-events", "up", "demo", "--build"]);
    expect(up).toHaveBeenCalledWith("/project", "demo", { build: true });
  });

  it("passes parsed event query options to the events workflow", async () => {
    const events = vi.fn(() => Effect.succeed([]));
    const run = vi.fn(async (effect) => {
      await Effect.runPromise(effect);
    });
    const program = createProgram({ rootDir: () => "/project", run, workflows: { events } });
    await program.parseAsync(["node", "biodome", "events", "--run", "run-1", "--limit", "50"]);
    expect(events).toHaveBeenCalledWith("/project", { runId: "run-1", limit: 50 });
  });
});
