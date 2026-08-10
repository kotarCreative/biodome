import { describe, expect, it } from "vitest";
import {
  buildSbxCreateArgs,
  buildSbxExecArgs,
  parseSbxListOutput,
  translateWorkspaceCommand,
  inferSbxAgent,
  dockerSandboxDriver,
} from "../../runtime/docker-sandbox.js";
import { createPlan } from "../../core/plan.js";

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

describe("inferSbxAgent", () => {
  it("selects the Docker Sandbox agent matching the task harness", () => {
    const plan = createPlan("test");
    plan.runtime.codexHarnesses.push({
      name: "reviewer",
      type: "codex",
      port: 3003,
      mcpServers: {},
      telemetry: { enabled: false, path: "" },
      config: {},
    });
    plan.deployment = {
      target: { name: "secure", driver: "docker-sandbox", options: {} },
      deploymentId: "test-secure",
      task: {
        name: "review",
        harness: "reviewer",
        prompt: "review",
        artifacts: [],
        timeout: "5m",
        cleanup: "always",
      },
    };
    expect(inferSbxAgent(plan)).toBe("codex");
  });
});

describe("Docker Sandbox capabilities", () => {
  it("advertises process signaling but not unenforced network policy", () => {
    expect(dockerSandboxDriver.capabilities.has("process.signal")).toBe(true);
    expect(dockerSandboxDriver.capabilities.has("network.policy")).toBe(false);
  });
});
