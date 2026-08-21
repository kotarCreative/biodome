import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTaskWorkflow, taskPlanWorkflow } from "../../../cli/workflows/task.js";
import { NoOpEventStoreLive } from "../../../core/events.js";

function writeProject(dir: string): void {
  const configDir = join(dir, ".biodome");
  mkdirSync(join(configDir, "tasks"), { recursive: true });
  mkdirSync(join(configDir, "features"), { recursive: true });
  mkdirSync(join(configDir, "targets"), { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ project: { name: "tasks" } }));
  writeFileSync(join(configDir, "services.mjs"), "export default function services(ctx) {\n}\n");
  writeFileSync(
    join(configDir, "features", "harnesses.mjs"),
    'export default function harnesses(ctx) {\n  ctx.addOpencodeHarness({ name: "opencode" });\n}\n',
  );
  writeFileSync(
    join(configDir, "targets", "local.mjs"),
    'export default function local(ctx) {\n  ctx.useRuntime("docker-compose");\n}\n',
  );
  writeFileSync(
    join(configDir, "tasks", "check.mjs"),
    'export default function check(ctx) {\n  ctx.addTask({ harness: "opencode", prompt: "Say hi" });\n}\n',
  );
}

describe("task workflows", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "task-workflow-"));
    writeProject(rootDir);
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it("compiles a portable plan for a declared task", async () => {
    const result = await Effect.runPromise(taskPlanWorkflow(rootDir, "local", "check"));
    expect(result.executionPlan.task.name).toBe("check");
    expect(result.executionPlan.target.name).toBe("local");
    expect(result.compatibility.compatible).toBe(true);
    expect(result.report).toContain("compatible");
    expect(result.error).toBeUndefined();
  });

  it("rejects unknown tasks", async () => {
    await expect(Effect.runPromise(taskPlanWorkflow(rootDir, "local", "missing"))).rejects.toThrow(
      'Task "missing" not found',
    );
  });

  it("rejects task names that resolve outside the tasks directory", async () => {
    await expect(
      Effect.runPromise(taskPlanWorkflow(rootDir, "local", "../escape")),
    ).rejects.toThrow(/resolves outside|Invalid task name/);
  });

  it("rejects run requests for unknown tasks before touching a driver", async () => {
    await expect(
      Effect.runPromise(
        runTaskWorkflow(rootDir, "local", "missing").pipe(
          Effect.provide(NoOpEventStoreLive("test")),
        ),
      ),
    ).rejects.toThrow('Task "missing" not found');
  });
});
