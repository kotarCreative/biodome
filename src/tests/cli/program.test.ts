import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../../cli/program.js";
import type { ProgramDependencies } from "../../cli/program.js";
import type { SandboxError } from "../../core/errors.js";
import { RuntimeError } from "../../core/errors.js";
import { ProfileSelection } from "../../core/profiles.js";

function exitOverrides(command: Command): Command {
  command.exitOverride();
  for (const sub of command.commands) exitOverrides(sub);
  return command;
}

function testProgram(workflows: NonNullable<ProgramDependencies["workflows"]>) {
  const run = vi.fn(async (effect: Effect.Effect<void, SandboxError, never>) => {
    await Effect.runPromise(effect);
  });
  const program = createProgram({ rootDir: () => "/project", run, workflows });
  return { program, run };
}

describe("CLI program parsing", () => {
  it("forwards complete executable names and argument arrays to exec", async () => {
    const exec = vi.fn(() => Effect.succeed({ message: "completed" }));
    const { program } = testProgram({ exec });
    await program.parseAsync([
      "node",
      "biodome",
      "--no-events",
      "exec",
      "local",
      "node",
      "-e",
      "console.log('literal argument')",
      "--help",
    ]);
    expect(exec).toHaveBeenCalledWith("/project", "local", [
      "node",
      "-e",
      "console.log('literal argument')",
      "--help",
    ]);
  });

  it("does not interpret guest version and profile flags as Biodome options", async () => {
    const exec = vi.fn(() => Effect.succeed({ message: "completed" }));
    const { program } = testProgram({ exec });
    await exitOverrides(program).parseAsync([
      "node",
      "biodome",
      "--no-events",
      "exec",
      "local",
      "tool",
      "--version",
      "--profile",
      "browser-profile",
    ]);
    expect(exec).toHaveBeenCalledWith("/project", "local", [
      "tool",
      "--version",
      "--profile",
      "browser-profile",
    ]);
  });

  it("supports global options after ordinary subcommands and an exec separator", async () => {
    const selected: (string | undefined)[] = [];
    const { program } = testProgram({
      build: () =>
        Effect.gen(function* () {
          const selection = yield* Effect.serviceOption(ProfileSelection);
          selected.push(selection._tag === "Some" ? selection.value.name : undefined);
          return { message: "built" };
        }),
    });
    await program.parseAsync([
      "node",
      "biodome",
      "build",
      "local",
      "--profile",
      "qa",
      "--no-events",
    ]);
    expect(selected).toEqual(["qa"]);
    const exec = vi.fn(() => Effect.succeed({ message: "completed" }));
    await testProgram({ exec }).program.parseAsync([
      "node",
      "biodome",
      "--no-events",
      "exec",
      "local",
      "--",
      "node",
      "--version",
    ]);
    expect(exec).toHaveBeenCalledWith("/project", "local", ["node", "--version"]);
  });
  it("passes build target arguments to the build workflow", async () => {
    const build = vi.fn(() => Effect.succeed({ message: "built" }));
    const { program, run } = testProgram({ build });
    await program.parseAsync(["node", "biodome", "--no-events", "build", "demo"]);
    expect(build).toHaveBeenCalledWith("/project", "demo");
    expect(run).toHaveBeenCalledOnce();
  });

  it("passes up options to the up workflow", async () => {
    const up = vi.fn(() => Effect.succeed({ message: "running", waiting: false }));
    const { program } = testProgram({ up });
    await program.parseAsync(["node", "biodome", "--no-events", "up", "demo", "--build"]);
    expect(up).toHaveBeenCalledWith("/project", "demo", { build: true });
  });

  it("passes parsed event query options to the events workflow", async () => {
    const events = vi.fn(() => Effect.succeed([]));
    const { program } = testProgram({ events });
    await program.parseAsync(["node", "biodome", "events", "--run", "run-1", "--limit", "50"]);
    expect(events).toHaveBeenCalledWith("/project", { runId: "run-1", limit: 50 });
  });

  it("rejects an out-of-range event limit with a clean error and exit code 1", async () => {
    const events = vi.fn(() => Effect.succeed([]));
    const { program, run } = testProgram({ events });
    await expect(
      exitOverrides(program).parseAsync(["node", "biodome", "events", "--limit", "0"]),
    ).rejects.toMatchObject({ exitCode: 1, message: /--limit must be an integer between 1 and/ });
    expect(events).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("passes action metadata through the CLI without interpreting the input", async () => {
    const taskPlan = vi.fn(() => Effect.fail(new RuntimeError({ message: "Stop after parsing" })));
    const { program } = testProgram({ taskPlan });
    await expect(
      program.parseAsync([
        "node",
        "biodome",
        "plan",
        "local",
        "qa",
        "--input",
        '{"route":"$(no-shell)"}',
        "--intent",
        "Check checkout",
        "--output",
        "qa/result.json",
      ]),
    ).rejects.toThrow();
    expect(taskPlan).toHaveBeenCalledWith("/project", "local", "qa", {
      input: { route: "$(no-shell)" },
      intent: "Check checkout",
      outputs: ["qa/result.json"],
    });
  });

  it.each(["[]", "null", "not-json"])(
    "rejects non-object action input %s before calling a workflow",
    async (input) => {
      const { program, run } = testProgram({});
      await expect(
        exitOverrides(program).parseAsync([
          "node",
          "biodome",
          "plan",
          "local",
          "qa",
          "--input",
          input,
        ]),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("returns machine-readable evidence when a JSON action fails", async () => {
    const artifacts = [
      { path: "qa/result.json", sizeBytes: 12, localPath: "/evidence/run/qa/result.json" },
    ];
    const { program } = testProgram({
      runTask: () =>
        Effect.fail(new RuntimeError({ message: "Assertion failed", exitCode: 7, artifacts })),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        program.parseAsync(["node", "biodome", "--no-events", "run", "local", "qa", "--json"]),
      ).rejects.toThrow("Assertion failed");
      expect(log).toHaveBeenCalledOnce();
      const result = JSON.parse(String(log.mock.calls[0][0]));
      expect(result).toMatchObject({ exitCode: 7, error: "Assertion failed", artifacts });
      expect(result.runId).toEqual(expect.any(String));
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["--no-events", "run", "local", "qa", "--stream"],
    ["run", "local", "qa", "--stream", "--json"],
  ])("rejects incompatible stream options %j", async (...args) => {
    const { program, run } = testProgram({});
    await expect(exitOverrides(program).parseAsync(["node", "biodome", ...args])).rejects.toThrow(
      "--stream requires event capture",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("routes interactive shells without turning them into actions", async () => {
    const shell = vi.fn(() => Effect.succeed(undefined));
    const { program } = testProgram({ shell });
    await program.parseAsync(["node", "biodome", "--no-events", "shell", "local"]);
    expect(shell).toHaveBeenCalledWith("/project", "local");
  });

  it("routes down through a stubbed workflow", async () => {
    const down = vi.fn(() => Effect.succeed({ message: "stopped" }));
    const { program, run } = testProgram({ down });
    await program.parseAsync(["node", "biodome", "--no-events", "down", "demo"]);
    expect(down).toHaveBeenCalledWith("/project", "demo");
    expect(run).toHaveBeenCalledOnce();
  });

  it("routes ps through a stubbed workflow", async () => {
    const ps = vi.fn(() => Effect.succeed({ status: { state: "running" as const } }));
    const { program } = testProgram({ ps });
    await program.parseAsync(["node", "biodome", "--no-events", "ps", "demo"]);
    expect(ps).toHaveBeenCalledWith("/project", "demo");
  });

  it("routes restart through a stubbed workflow", async () => {
    const restart = vi.fn(() =>
      Effect.succeed({ message: 'Restart completed on target "demo"', skipped: [] }),
    );
    const { program } = testProgram({ restart });
    await program.parseAsync(["node", "biodome", "--no-events", "restart", "demo", "web"]);
    expect(restart).toHaveBeenCalledWith("/project", "demo", "web");
  });

  it("routes app list through a stubbed workflow", async () => {
    const appList = vi.fn(() => Effect.succeed("No applications declared\n"));
    const { program } = testProgram({ appList });
    await program.parseAsync(["node", "biodome", "app", "list"]);
    expect(appList).toHaveBeenCalledWith("/project");
  });

  it("routes config validate through a stubbed workflow", async () => {
    const configValidate = vi.fn(() => Effect.succeed({ message: "Configuration is valid" }));
    const { program } = testProgram({ configValidate });
    await program.parseAsync(["node", "biodome", "--no-events", "config", "validate"]);
    expect(configValidate).toHaveBeenCalledWith("/project");
  });
});
