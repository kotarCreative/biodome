import { describe, expect, it, vi } from "vitest";
import * as driverKit from "../../runtime/driver-kit.js";
import {
  buildSbxCreateArgs,
  buildSbxExecArgs,
  parseSbxListOutput,
  translateWorkspaceCommand,
  dockerSandboxDriver,
} from "../../runtime/docker-sandbox.js";
import { createPlan } from "../../core/plan.js";
import { NoOpEventStoreLive } from "../../core/events.js";
import { Effect } from "effect";

describe("Docker Sandboxes argument builders", () => {
  it("creates a named shell sandbox for the project workspace", () => {
    expect(buildSbxCreateArgs("review-123", "/projects/app")).toEqual([
      "create",
      "--name",
      "review-123",
      "shell",
      "/projects/app",
    ]);
  });

  it("passes through template, kit, clone, and resource options", () => {
    expect(
      buildSbxCreateArgs("review-123", "/projects/app", {
        agent: "codex",
        clone: true,
        cpus: 4,
        memory: "8g",
        template: "ghcr.io/acme/app-agent:v1",
        kits: ["./kit-a", "oci://example/kit-b"],
      }),
    ).toEqual([
      "create",
      "--name",
      "review-123",
      "--clone",
      "--cpus",
      "4",
      "--memory",
      "8g",
      "--template",
      "ghcr.io/acme/app-agent:v1",
      "--kit",
      "./kit-a",
      "--kit",
      "oci://example/kit-b",
      "codex",
      "/projects/app",
    ]);
  });

  it("enforces timed commands inside the sandbox", () => {
    expect(buildSbxExecArgs("review-123", ["npm", "test"], 1_500)).toEqual([
      "exec",
      "review-123",
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "2s",
      "npm",
      "test",
    ]);
  });

  it("translates generated /workspace wrapper paths to the sandbox workspace", () => {
    expect(
      translateWorkspaceCommand(
        ["/workspace/.biodome-build/targets/local/codex-homes/reviewer/task", "prompt"],
        "/projects/app",
      ),
    ).toEqual(["/projects/app/.biodome-build/targets/local/codex-homes/reviewer/task", "prompt"]);
  });
});

describe("parseSbxListOutput", () => {
  it("recognizes the sandbox in an array response", () => {
    expect(
      parseSbxListOutput(JSON.stringify([{ name: "review-123", status: "running" }]), "review-123"),
    ).toEqual({ state: "running" });
  });

  it("supports object-wrapped prerelease list output", () => {
    expect(
      parseSbxListOutput(
        JSON.stringify({ sandboxes: [{ id: "review-123", state: "exited" }] }),
        "review-123",
      ),
    ).toEqual({ state: "stopped" });
  });

  it("returns an explicit unknown state for malformed or missing results", () => {
    expect(parseSbxListOutput("not json", "review-123")).toEqual({
      state: "unknown",
      message: "sbx returned invalid JSON",
    });
    expect(parseSbxListOutput("[]", "review-123")).toEqual({
      state: "unknown",
      message: "Sandbox not found",
    });
  });
});

describe("Docker Sandbox capabilities", () => {
  it("executes as the guest workload user and enforces timeout inside that container", async () => {
    const capture = vi
      .spyOn(driverKit, "captureTimedExec")
      .mockReturnValue(Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }));
    try {
      await Effect.runPromise(
        dockerSandboxDriver
          .exec({
            rootDir: "/project",
            outputDir: "/project/.biodome-build/targets/local",
            plan: createPlan("test"),
            target: { name: "local", driver: "docker-sandbox", options: {} },
            deploymentId: "test-deploy",
            command: ["node", "check.mjs"],
            timeoutMs: 1500,
            state: {
              schemaVersion: 1,
              target: "local",
              driver: "docker-sandbox",
              deploymentId: "test-deploy",
              resourceIds: { sandbox: "sbx-id" },
              createdAt: new Date().toISOString(),
            },
          })
          .pipe(Effect.provide(NoOpEventStoreLive("test"))),
      );
      expect(capture).toHaveBeenCalledWith({
        command: "sbx",
        cwd: "/project",
        timeoutMs: 1500,
        args: [
          "exec",
          "sbx-id",
          "docker",
          "exec",
          "--user",
          "biodome",
          "--env",
          "HOME=/home/biodome",
          "--workdir",
          "/workspace",
          "test-deploy-dev",
          "timeout",
          "--signal=TERM",
          "--kill-after=5s",
          "2s",
          "node",
          "check.mjs",
        ],
      });
    } finally {
      capture.mockRestore();
    }
  });
  it("advertises process signaling but not unenforced network policy", () => {
    expect(dockerSandboxDriver.capabilities.has("process.signal")).toBe(true);
    expect(dockerSandboxDriver.capabilities.has("network.policy")).toBe(false);
  });

  it("requires a validated sandbox identity for stateful operations", async () => {
    const plan = createPlan("test");
    const target = { name: "local", driver: "docker-sandbox" as const, options: {} };
    await expect(
      Effect.runPromise(
        dockerSandboxDriver
          .status({
            rootDir: "/project",
            outputDir: "/project/.biodome-build/targets/local",
            plan,
            target,
            deploymentId: "deployment",
          })
          .pipe(Effect.provide(NoOpEventStoreLive("test"))),
      ),
    ).rejects.toThrow(/requires validated deployment state/);
  });
});
