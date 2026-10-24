import { describe, expect, it } from "vitest";
import { generateCompose } from "../../../docker/generators/compose.js";
import { createPlan } from "../../../core/plan.js";

describe("generateCompose", () => {
  it("uses target-specific Compose paths when provided", () => {
    const compose = generateCompose(createPlan("my-app"), {
      buildContext: "../../..",
      dockerfile: ".biodome-build/targets/local/Dockerfile",
      workspace: "../../..",
    });

    expect(compose).toContain("context: ../../..");
    expect(compose).toContain("dockerfile: .biodome-build/targets/local/Dockerfile");
    expect(compose).toContain("- ../../..:/workspace");
    expect(compose).toContain("${BIODOME_DEV_IMAGE:-my-app-dev:latest}");
  });

  it("generates compose with ports and no sleep infinity for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:8000/admin/login/",
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    const compose = generateCompose(plan);
    // Published ports must bind to host loopback only, never all interfaces.
    expect(compose).toContain("- 127.0.0.1:8000:8000");
    expect(compose).toMatch(/ports:\n\s+- 127\.0\.0\.1:/);
    expect(compose).not.toMatch(/^\s+- \d+:\d+$/m);
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("sh /workspace/.biodome-build/healthchecks/all.sh");
    // Fast probes while starting; the wait must not add a full process
    // health-check interval after the app is already serving.
    expect(compose).toContain("start_interval: 1s");
    expect(compose).toContain("interval: 5s");
    expect(compose).not.toContain("sleep infinity");
    expect(compose).toContain("..:/workspace");
  });

  it("bakes literal runtime env vars into the compose environment", () => {
    const plan = createPlan("my-app");
    plan.runtime.environment.DEBUG = "1";
    plan.runtime.envVars.push({ key: "DEBUG", scope: "both", value: "1" });

    const compose = generateCompose(plan);
    expect(compose).toContain('DEBUG: "1"');
  });

  it("exposes runtime-identity uid/gid mapping knobs with image defaults", () => {
    const compose = generateCompose(createPlan("my-app"));
    expect(compose).toContain("BIODOME_RUNTIME_UID: ${BIODOME_RUNTIME_UID:-10001}");
    expect(compose).toContain("BIODOME_RUNTIME_GID: ${BIODOME_RUNTIME_GID:-10001}");
  });

  it("emits passthrough env vars as compose interpolations, not literals", () => {
    const plan = createPlan("my-app");
    plan.runtime.envVars.push(
      { key: "DATABASE_URL", scope: "runtime", from: { env: "DATABASE_URL" }, required: true },
      { key: "PORT", scope: "runtime", from: { env: "PORT" }, default: "8000" },
      { key: "API_KEY", scope: "runtime", from: { env: "API_KEY" } },
    );

    const compose = generateCompose(plan);
    // Required -> fails compose if unset.
    expect(compose).toContain("${DATABASE_URL:?DATABASE_URL is required by DATABASE_URL}");
    // Default -> falls back.
    expect(compose).toContain("${PORT:-8000}");
    // Plain passthrough.
    expect(compose).toContain("${API_KEY}");
  });

  it("resolves AWS secret ARN references from a host variable of the same key", () => {
    const plan = createPlan("my-app");
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:pg-AbCdEf";
    plan.runtime.envVars.push({ key: "POSTGRES_PASSWORD", scope: "runtime", from: { secretArn } });

    const compose = generateCompose(plan);
    // Locally there is no ECS secret injection, so the value must come from the
    // host environment under its own key, failing loudly when absent.
    expect(compose).toContain(
      "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required by POSTGRES_PASSWORD}",
    );
    // The ARN identifies the source but never a secret value.
    expect(compose).not.toContain("secretArn");
  });

  it("keeps build-scoped passthrough vars out of the runtime compose env", () => {
    const plan = createPlan("my-app");
    plan.runtime.envVars.push({
      key: "BUILD_TOKEN",
      scope: "build",
      from: { env: "BUILD_TOKEN" },
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("BUILD_TOKEN");
  });

  it("adds local bind mounts to the dev service", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("./data:/workspace/data");
  });

  it("adds read-only local bind mounts", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
      readOnly: true,
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("./data:/workspace/data:ro");
  });

  it("declares named local volumes in the compose volumes section", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "shared",
      type: "local",
      source: "shared-data",
      target: "/workspace/shared",
    });

    const compose = generateCompose(plan);
    expect(compose).toContain("shared-data:/workspace/shared");
    expect(compose).toContain("volumes:\n  shared-data:");
  });

  it("adds FUSE capabilities for cloud-backed volumes instead of privileged mode", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "s3-data",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-data",
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("privileged:");
    expect(compose).toContain("/dev/fuse");
    expect(compose).toContain("SYS_ADMIN");
    expect(compose).toContain("no-new-privileges");
  });

  it("does not add FUSE devices for local volumes only", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "data",
      type: "local",
      source: "./data",
      target: "/workspace/data",
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("privileged");
    expect(compose).not.toContain("/dev/fuse");
  });

  it("does not add FUSE devices when all cloud volumes are proxy volumes", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "s3-proxy",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-proxy",
      proxy: true,
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("privileged");
    expect(compose).not.toContain("/dev/fuse");
    expect(compose).not.toContain("/workspace/s3-proxy");
  });

  it("does not mount local proxy volumes in the dev service", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "local-proxy",
      type: "local",
      source: "./data",
      target: "/workspace/data",
      proxy: true,
    });

    const compose = generateCompose(plan);
    expect(compose).not.toContain("./data:/workspace/data");
  });
});
