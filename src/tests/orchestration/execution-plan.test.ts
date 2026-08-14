import { describe, expect, it } from "vitest";
import { decodeExecutionPlan } from "../../orchestration/execution-plan.js";

const document = {
  version: 1,
  project: "demo",
  target: { name: "local", provider: "docker-sandbox", options: {} },
  task: {
    name: "review",
    agent: { harness: "codex" },
    prompt: "Review",
    timeout: "30m",
    cleanup: "always",
    requiredServices: ["postgres"],
    requiredProcesses: ["api"],
    capabilities: [{ capability: "artifact.collect", level: "required" }],
    network: { mode: "egress", allow: ["api.openai.com:443"] },
    secrets: [
      {
        name: "openai",
        purpose: "agent authentication",
        exposure: "request-proxy",
        destinations: ["api.openai.com"],
        required: true,
      },
    ],
    workspace: { strategy: "clone", repository: "https://example.test/demo.git", ref: "main" },
    artifacts: [{ path: "review.md", required: true }],
    validationCommands: [["npm", "test"]],
  },
  services: [
    {
      name: "postgres",
      kind: "postgres",
      runtime: "container",
      version: "17",
      persistence: "task",
    },
  ],
  processes: [{ name: "api", command: ["npm", "run", "dev"], mode: "daemon" }],
};

describe("ExecutionPlanSchema", () => {
  it("decodes a portable provider-neutral plan", () => {
    const plan = decodeExecutionPlan(document);
    expect(plan.target.provider).toBe("docker-sandbox");
    expect(plan.services[0]?.image).toBeUndefined();
  });

  it("rejects an invalid plan version", () => {
    expect(() => decodeExecutionPlan({ ...document, version: 2 })).toThrow();
  });
});
