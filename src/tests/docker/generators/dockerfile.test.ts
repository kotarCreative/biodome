import { describe, expect, it } from "vitest";
import { generateDockerfile } from "../../../docker/generators/dockerfile.js";
import { createPlan } from "../../../core/plan.js";

describe("generateDockerfile", () => {
  it("installs the AWS CLI for ECS artifact uploads", () => {
    const plan = createPlan("my-app");
    plan.deployment = {
      target: {
        name: "remote",
        driver: "aws-ecs",
        options: { artifactBucket: "task-artifacts" },
      },
      deploymentId: "my-app-remote",
    };

    expect(generateDockerfile(plan)).toContain("awscli");
  });

  it("generates a Dockerfile with supervisord for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.build.baseImage = "python:3.12-slim";
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("FROM python:3.12-slim AS base");
    expect(dockerfile).toContain("supervisor");
    expect(dockerfile).toContain("startup.sh");
    expect(dockerfile).toContain('CMD ["sh", "/workspace/.biodome-build/startup.sh"]');
    expect(dockerfile).not.toContain('CMD ["bash"]');
  });

  it("does not include bash CMD when no daemon processes exist", () => {
    const plan = createPlan("my-app");
    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain('CMD ["bash"]');
  });

  it("copies target-scoped generated files for image-only runtimes", () => {
    const dockerfile = generateDockerfile(createPlan("my-app"), {
      generatedFilesPath: ".biodome-build/targets/staging",
    });

    expect(dockerfile).toContain("COPY .biodome-build/targets/staging/ /workspace/.biodome-build/");
  });

  it("bakes literal build env vars into the Dockerfile", () => {
    const plan = createPlan("my-app");
    plan.build.environment.DEBUG = "1";
    plan.runtime.envVars.push({ key: "DEBUG", scope: "both", value: "1" });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("DEBUG=1");
  });

  it("never bakes passthrough env vars into the image", () => {
    const plan = createPlan("my-app");
    plan.runtime.envVars.push(
      { key: "DATABASE_URL", scope: "runtime", from: { env: "DATABASE_URL" }, required: true },
      { key: "API_KEY", scope: "runtime", from: { env: "API_KEY" } },
    );

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).not.toContain("DATABASE_URL");
    expect(dockerfile).not.toContain("API_KEY");
  });

  it("installs only the provider SDKs needed by proxy volumes in the Dockerfile", () => {
    const plan = createPlan("my-app");
    plan.build.mcpEnabled = true;
    plan.runtime.volumes.push({
      name: "s3-proxy",
      type: "s3",
      bucket: "my-bucket",
      target: "/workspace/s3-proxy",
      proxy: true,
    });
    plan.runtime.volumes.push({
      name: "azure-proxy",
      type: "azure",
      account: "myaccount",
      container: "mycontainer",
      target: "/workspace/azure-proxy",
      proxy: true,
    });

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("@aws-sdk/client-s3");
    expect(dockerfile).toContain("@azure/storage-blob");
    expect(dockerfile).not.toContain("@google-cloud/storage");
  });

  it("does not install provider SDKs when no proxy volumes exist", () => {
    const plan = createPlan("my-app");
    plan.build.mcpEnabled = true;

    const dockerfile = generateDockerfile(plan);
    expect(dockerfile).toContain("@modelcontextprotocol/sdk");
    expect(dockerfile).not.toContain("@aws-sdk/client-s3");
    expect(dockerfile).not.toContain("@google-cloud/storage");
    expect(dockerfile).not.toContain("@azure/storage-blob");
  });
});
