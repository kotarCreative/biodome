import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import {
  detectStarterLanguages,
  generateStarterFeature,
  runHooks,
  resolveProjectName,
  runSafe,
} from "../../cli/helpers.js";
import { createPlan } from "../../core/plan.js";
import type { SandboxRuntime } from "../../core/runtime.js";
import { PlanError } from "../../core/errors.js";
import { NoOpEventStoreLive, FileEventStoreLive, readEventsFromPath } from "../../core/events.js";

function tmpDir(prefix: string): string {
  return join("/tmp", `${prefix}-${Date.now()}`);
}

const NodeRuntime = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
);

describe("resolveProjectName", () => {
  it("reads the project name from sandbox/config.json", () => {
    const dir = tmpDir("project-name");
    mkdirSync(join(dir, "biodome"), { recursive: true });
    writeFileSync(join(dir, "biodome", "config.json"), JSON.stringify({ project: { name: "my-app" } }));

    try {
      expect(resolveProjectName(dir)).toBe("my-app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runHooks", () => {
  it("runs container hooks through the provider", async () => {
    const plan = createPlan("test");
    plan.runtime.processes.push({
      name: "migrate",
      command: ["python", "manage.py", "migrate"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.post",
    });

    const exec = vi.fn().mockReturnValue(Effect.void);
    const runner = { exec } as unknown as SandboxRuntime;
    const program = runHooks(plan, "start.post", runner, "/tmp").pipe(
      Effect.provide(Layer.merge(NodeRuntime, NoOpEventStoreLive("test")))
    );
    await Effect.runPromise(program);
    expect(exec).toHaveBeenCalledWith(["python", "manage.py", "migrate"]);
  });

  it("does not run host hooks through the provider", async () => {
    const plan = createPlan("test");
    plan.runtime.processes.push({
      name: "check",
      command: ["echo", "ok"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "build.pre",
    });

    const exec = vi.fn().mockReturnValue(Effect.void);
    const runner = { exec } as unknown as SandboxRuntime;
    const program = runHooks(plan, "build.pre", runner, "/tmp").pipe(
      Effect.provide(Layer.merge(NodeRuntime, NoOpEventStoreLive("test")))
    );
    await Effect.runPromise(program);
    expect(exec).not.toHaveBeenCalled();
  });

  it("emits exactly one hook.completed event per sandbox hook", async () => {
    const dir = tmpDir("hook-events");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "events.jsonl");

    const plan = createPlan("test");
    plan.runtime.processes.push({
      name: "migrate",
      command: ["python", "manage.py", "migrate"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.post",
    });

    const exec = vi.fn().mockReturnValue(Effect.void);
    const runner = { exec } as unknown as SandboxRuntime;
    const program = runHooks(plan, "start.post", runner, "/tmp").pipe(
      Effect.provide(
        Layer.merge(NodeRuntime, FileEventStoreLive({ runId: "test", path: logPath }))
      )
    );

    try {
      await Effect.runPromise(program);
      const events = await Effect.runPromise(readEventsFromPath(logPath));
      const completed = events.filter((e) => e.type === "hook.completed");
      expect(completed).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores hooks at unrelated lifecycle points", async () => {
    const plan = createPlan("test");
    plan.runtime.processes.push({
      name: "migrate",
      command: ["python", "manage.py", "migrate"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.post",
    });

    const exec = vi.fn().mockReturnValue(Effect.void);
    const runner = { exec } as unknown as SandboxRuntime;
    const program = runHooks(plan, "stop.pre", runner, "/tmp").pipe(
      Effect.provide(Layer.merge(NodeRuntime, NoOpEventStoreLive("test")))
    );
    await Effect.runPromise(program);
    expect(exec).not.toHaveBeenCalled();
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
    await runSafe(Effect.fail(new PlanError({ message: "boom" })));

    expect(console.error).toHaveBeenCalledWith("Error: boom");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe("detectStarterLanguages", () => {
  it("detects node from package.json", () => {
    const dir = tmpDir("node-lang");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app" }));
    try {
      expect(detectStarterLanguages(dir)).toEqual([
        { name: "node", options: { version: "20" } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects node from bun lock files", () => {
    const dir = tmpDir("bun-lang");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bun.lockb"), "");
    try {
      expect(detectStarterLanguages(dir)).toEqual([
        { name: "node", options: { version: "20" } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects python from requirements.txt", () => {
    const dir = tmpDir("python-lang");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requirements.txt"), "django\n");
    try {
      expect(detectStarterLanguages(dir)).toEqual([
        { name: "python", options: { version: "3.12" } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects multiple languages", () => {
    const dir = tmpDir("multi-lang");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(join(dir, "requirements.txt"), "django\n");
    writeFileSync(join(dir, "go.mod"), "module example\n");
    try {
      expect(detectStarterLanguages(dir)).toEqual([
        { name: "node", options: { version: "20" } },
        { name: "python", options: { version: "3.12" } },
        { name: "go", options: { version: "1.22" } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty array when no project files are found", () => {
    const dir = tmpDir("no-lang");
    mkdirSync(dir, { recursive: true });
    try {
      expect(detectStarterLanguages(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generateStarterFeature", () => {
  it("generates a no-op feature when no languages are detected", () => {
    const feature = generateStarterFeature([]);
    expect(feature).toContain("export default function autoDetect(_ctx)");
    expect(feature).toContain("No languages detected");
  });

  it("generates addLanguage calls for detected languages", () => {
    const feature = generateStarterFeature([
      { name: "node", options: { version: "20" } },
      { name: "python", options: { version: "3.12" } },
    ]);
    expect(feature).toContain('export default function autoDetect(ctx) {');
    expect(feature).toContain('ctx.addLanguage("node", {"version":"20"})');
    expect(feature).toContain('ctx.addLanguage("python", {"version":"3.12"})');
  });
});
