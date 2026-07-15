import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHooks, resolveProjectName, runSafe } from "../../cli/helpers";
import { createPlan } from "../../core/plan";
import type { Provider } from "../../core/provider";

function tmpDir(prefix: string): string {
  return join("/tmp", `${prefix}-${Date.now()}`);
}

describe("resolveProjectName", () => {
  it("reads the project name from sandbox/config.json", () => {
    const dir = tmpDir("project-name");
    mkdirSync(join(dir, "sandbox"), { recursive: true });
    writeFileSync(join(dir, "sandbox", "config.json"), JSON.stringify({ project: { name: "my-app" } }));

    try {
      expect(resolveProjectName(dir)).toBe("my-app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runHooks", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs container hooks through the provider", () => {
    const plan = createPlan("test");
    plan.runtime.processes.push({
      name: "migrate",
      command: ["python", "manage.py", "migrate"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.post",
    });

    const runner = { execInDev: vi.fn() } as unknown as Provider;
    runHooks(plan, "start.post", runner, "/tmp");
    expect(runner.execInDev).toHaveBeenCalledWith(["python", "manage.py", "migrate"]);
  });

  it("does not run host hooks through the provider", () => {
    const plan = createPlan("test");
    plan.runtime.processes.push({
      name: "check",
      command: ["echo", "ok"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "build.pre",
    });

    const runner = { execInDev: vi.fn() } as unknown as Provider;
    runHooks(plan, "build.pre", runner, "/tmp");
    expect(runner.execInDev).not.toHaveBeenCalled();
  });

  it("ignores hooks at unrelated lifecycle points", () => {
    const plan = createPlan("test");
    plan.runtime.processes.push({
      name: "migrate",
      command: ["python", "manage.py", "migrate"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.post",
    });

    const runner = { execInDev: vi.fn() } as unknown as Provider;
    runHooks(plan, "stop.pre", runner, "/tmp");
    expect(runner.execInDev).not.toHaveBeenCalled();
  });
});

describe("runSafe", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a friendly error and exits on failure", async () => {
    await runSafe(async () => {
      throw new Error("boom");
    });

    expect(console.error).toHaveBeenCalledWith("Error: boom");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
