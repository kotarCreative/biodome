import { describe, expect, it } from "vitest";
import { generatePiHarnessFiles } from "../../../../docker/generators/harnesses/pi.js";
import { createPlan } from "../../../../core/plan.js";

describe("generatePiHarnessFiles", () => {
  it("uses the target-scoped home in generated task wrappers", () => {
    const plan = createPlan("test");
    plan.runtime.piHarnesses.push({
      name: "coder",
      type: "pi",
      telemetry: { enabled: false, path: "" },
      config: {},
    });
    plan.deployment = {
      target: { name: "local", driver: "docker-compose", options: {} },
      deploymentId: "test-local",
    };

    const task = generatePiHarnessFiles(plan)["pi-homes/coder/task"];
    expect(task).toContain(
      "PI_CODING_AGENT_DIR=/workspace/.biodome-build/targets/local/pi-homes/coder",
    );
  });

  it("generates Pi settings, wrapper script, and telemetry extension", () => {
    const plan = createPlan("test");
    plan.runtime.piHarnesses.push({
      name: "coder",
      type: "pi",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: { env: "ANTHROPIC_API_KEY" },
      tools: ["read", "bash", "edit", "write"],
      telemetry: { enabled: true, path: "/workspace/.biodome-build/logs/pi-coder-events.jsonl" },
      config: {},
    });

    const files = generatePiHarnessFiles(plan);
    expect(files["pi-homes/coder/settings.json"]).toContain('"defaultProvider": "anthropic"');
    expect(files["pi-homes/coder/settings.json"]).toContain(
      '"defaultModel": "claude-sonnet-4-20250514"',
    );
    expect(files["pi-homes/coder/settings.json"]).toContain('"extensions"');

    const wrapper = files["pi-homes/coder/pi"];
    expect(wrapper).toContain("#!/bin/sh");
    expect(wrapper).toContain("PI_CODING_AGENT_DIR=/workspace/.biodome-build/pi-homes/coder");
    expect(wrapper).toContain('ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"');
    expect(wrapper).toContain("--tools read,bash,edit,write");

    const task = files["pi-homes/coder/task"];
    expect(task).toContain("#!/bin/sh");
    expect(task).toContain("PI_CODING_AGENT_DIR=/workspace/.biodome-build/pi-homes/coder");
    expect(task).toContain('pi -p "$@"');
    expect(task).toContain("aws s3 cp");

    const telemetry = files["pi-homes/coder/extensions/biodome-telemetry.ts"];
    expect(telemetry).toContain("export default function (pi)");
    expect(telemetry).toContain("agent_start");
    expect(telemetry).toContain("tool_execution_start");
    expect(telemetry).toContain("const CAPTURE_PAYLOADS = false");
  });

  it("omits telemetry extension when disabled", () => {
    const plan = createPlan("test");
    plan.runtime.piHarnesses.push({
      name: "coder",
      type: "pi",
      telemetry: { enabled: false, path: "" },
      config: {},
    });

    const files = generatePiHarnessFiles(plan);
    expect(files["pi-homes/coder/extensions/biodome-telemetry.ts"]).toBeUndefined();
  });

  it("captures Pi telemetry payloads only when explicitly enabled", () => {
    const plan = createPlan("test");
    plan.runtime.piHarnesses.push({
      name: "pi",
      type: "pi",
      telemetry: { enabled: true, path: "/workspace/events.jsonl", capturePayloads: true },
      config: {},
    });

    expect(generatePiHarnessFiles(plan)["pi-homes/pi/extensions/biodome-telemetry.ts"]).toContain(
      "const CAPTURE_PAYLOADS = true",
    );
  });
});
