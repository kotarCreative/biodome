import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { buildxImageDigest, createAwsEcsDriver, type AwsClients } from "../../runtime/aws-ecs.js";
import type { RuntimeTarget } from "../../core/plan.js";
import type { Plan } from "../../core/plan.js";
import type { RuntimeOperationInput } from "../../runtime/driver.js";
import { RuntimeError } from "../../core/errors.js";
import { NoOpEventStoreLive, type EventStore } from "../../core/events.js";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runtimeLayout } from "../../runtime/layout.js";

function makeEcrClient(sendFn?: ReturnType<typeof vi.fn>) {
  return {
    config: { region: vi.fn().mockResolvedValue("us-east-1") },
    send: sendFn ?? vi.fn(),
  } as unknown as AwsClients["ecr"];
}

function makeEcsClient(sendFn?: ReturnType<typeof vi.fn>) {
  return {
    send: sendFn ?? vi.fn(),
  } as unknown as AwsClients["ecs"];
}

function makeCloudwatchClient(sendFn?: ReturnType<typeof vi.fn>) {
  return {
    send: sendFn ?? vi.fn().mockResolvedValue({}),
  } as unknown as AwsClients["cloudwatch"];
}

function makeClients(overrides?: {
  ecrSend?: ReturnType<typeof vi.fn>;
  ecsSend?: ReturnType<typeof vi.fn>;
  cwSend?: ReturnType<typeof vi.fn>;
}): AwsClients {
  return {
    ecr: makeEcrClient(overrides?.ecrSend),
    ecs: makeEcsClient(overrides?.ecsSend),
    cloudwatch: makeCloudwatchClient(overrides?.cwSend),
  };
}

function run<A>(effect: Effect.Effect<A, RuntimeError, EventStore>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(NoOpEventStoreLive("test-run"))));
}

const sampleTarget: RuntimeTarget = {
  name: "test-target",
  driver: "aws-ecs",
  options: {
    region: "us-east-1",
    cluster: "test-cluster",
    repository: "123456789012.dkr.ecr.us-east-1.amazonaws.com/test-repo",
    executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
    subnets: ["subnet-abc", "subnet-def"],
    securityGroups: ["sg-123"],
    assignPublicIp: true,
    cpu: 1024,
    memoryMiB: 2048,
  },
};

const samplePlan: Plan = {
  project: "test-project",
  build: {
    project: "test-project",
    baseImage: "debian:12-slim",
    aptPackages: [],
    runtimeInstalls: [],
    languageSnippets: [],
    languageRequests: [],
    dependencyFiles: [],
    dependencyInstalls: [],
    copyArtifacts: [],
    environment: {},
    nodeModulesVolume: false,
    venvVolume: false,
    vendorVolume: false,
    mcpEnabled: false,
    mcpPort: 0,
    mcpConfig: {
      enabled: false,
      port: 0,
      allowExec: false,
      allowProcessControl: false,
      maxReadBytes: 0,
      maxWriteBytes: 0,
      maxListEntries: 0,
      providerConnectTimeoutMs: 0,
      providerRequestTimeoutMs: 0,
      providerCatalogConcurrency: 0,
    },
  },
  runtime: {
    processes: [],
    services: [],
    volumes: [],
    namedVolumes: [],
    networks: [],
    ports: [],
    environment: {},
    envVars: [],
    endpoints: [],
    providers: [],
    repos: [],
    agentHarnesses: [],
    piHarnesses: [],
    codexHarnesses: [],
    claudeHarnesses: [],
    llmProviders: [],
  },
};

function makeInput(overrides?: Partial<RuntimeOperationInput>): RuntimeOperationInput {
  return {
    rootDir: "/tmp/root",
    outputDir: "/tmp/output",
    plan: samplePlan,
    target: sampleTarget,
    deploymentId: "test-deploy-001",
    buildManifest: {
      schemaVersion: 1,
      target: sampleTarget.name,
      driver: "aws-ecs",
      deploymentId: "test-deploy-001",
      imageRef: `123456789012.dkr.ecr.us-east-1.amazonaws.com/test-repo@sha256:${"a".repeat(64)}`,
      digest: `sha256:${"a".repeat(64)}`,
      contentId: "test-content",
      createdAt: new Date().toISOString(),
      provider: {},
    },
    ...overrides,
  };
}

function makeState(resourceIds: Record<string, string>): RuntimeOperationInput["state"] {
  return {
    schemaVersion: 1,
    target: sampleTarget.name,
    driver: "aws-ecs",
    deploymentId: "test-deploy-001",
    createdAt: new Date().toISOString(),
    resourceIds,
  };
}

describe("createAwsEcsDriver", () => {
  describe("id and capabilities", () => {
    const driver = createAwsEcsDriver(makeClients());

    it("has the correct driver id", () => {
      expect(driver.id).toBe("aws-ecs");
    });

    it("advertises build, start, stop, status, logs, exec, and artifact capabilities", () => {
      const caps = driver.capabilities;
      expect(caps).toContain("lifecycle.build");
      expect(caps).toContain("lifecycle.start");
      expect(caps).toContain("lifecycle.stop");
      expect(caps).toContain("status.read");
      expect(caps).toContain("logs.stream");
      expect(caps).toContain("job.run");
      expect(caps).toContain("artifact.collect");
    });
  });

  describe("render", () => {
    it("generates a Dockerfile and other build files", () => {
      const rootDir = join(tmpdir(), `ecs-root-${randomUUID()}`);
      const outputDir = runtimeLayout(rootDir, sampleTarget.name).host.root;
      mkdirSync(rootDir, { recursive: true });
      try {
        const driver = createAwsEcsDriver(makeClients());
        const result = Effect.runSync(
          driver.render({
            rootDir,
            outputDir,
            plan: samplePlan,
            target: sampleTarget,
          }),
        );
        expect(result).toContain(join(outputDir, "Dockerfile"));
        expect(result.length).toBeGreaterThan(1);
        const dockerfile = readFileSync(join(outputDir, "Dockerfile"), "utf-8");
        expect(dockerfile).toContain(
          "COPY .biodome-build/targets/test-target/ /workspace/.biodome-build/",
        );
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("rejects plan rendering when backing services are present", () => {
      const driver = createAwsEcsDriver(makeClients());
      const planWithServices: Plan = {
        ...samplePlan,
        runtime: {
          ...samplePlan.runtime,
          services: [{ name: "postgres", image: "postgres:16" } as any],
        },
      };
      expect(() =>
        Effect.runSync(
          driver.render({
            rootDir: "/tmp/root",
            outputDir: "/tmp/output",
            plan: planWithServices,
            target: sampleTarget,
          }),
        ),
      ).toThrow(/does not support backing service containers/);
    });

    it("renders plans with process-hosted services", () => {
      const rootDir = join(tmpdir(), `ecs-root-${randomUUID()}`);
      const outputDir = runtimeLayout(rootDir, sampleTarget.name).host.root;
      mkdirSync(rootDir, { recursive: true });
      try {
        const planWithPostgres: Plan = {
          ...samplePlan,
          runtime: {
            ...samplePlan.runtime,
            services: [
              {
                name: "postgres",
                type: "postgres",
                runtime: "process",
                image: "postgresql (in-container)",
                containerName: "test-postgres",
                environment: {},
                ports: [],
                volumes: [],
                networks: [],
              },
            ],
          },
        };
        const driver = createAwsEcsDriver(makeClients());
        expect(
          Effect.runSync(
            driver.render({ rootDir, outputDir, plan: planWithPostgres, target: sampleTarget }),
          ),
        ).toContain(join(outputDir, "Dockerfile"));
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe("start", () => {
    it("registers a task definition and runs a task", async () => {
      const calls: string[] = [];
      const cwSend = vi.fn().mockImplementation(() => {
        calls.push("create-log-group");
        return Promise.resolve({});
      });
      const ecsSend = vi
        .fn()
        .mockImplementationOnce(() => {
          calls.push("register-task-definition");
          return Promise.resolve({
            taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
          });
        })
        .mockImplementationOnce(() => {
          calls.push("run-task");
          return Promise.resolve({
            tasks: [{ taskArn: "arn:aws:ecs:...:task/abc123" }],
            failures: [],
          });
        });
      const clients = makeClients({ ecsSend, cwSend });
      const driver = createAwsEcsDriver(clients);

      const result = await run(driver.start(makeInput()));

      expect(result.driver).toBe("aws-ecs");
      expect(result.deploymentId).toBe("test-deploy-001");
      expect(result.resourceIds.taskDefinitionArn).toBe("arn:aws:ecs:...:task-def/test-deploy:1");
      expect(result.resourceIds.taskArn).toBe("arn:aws:ecs:...:task/abc123");
      expect(result.resourceIds.logGroup).toBe("/biodome/test-project/test-target");
      expect(ecsSend).toHaveBeenCalledTimes(2);
      expect(calls).toEqual(["create-log-group", "register-task-definition", "run-task"]);
      expect(cwSend.mock.calls[0][0].input).toEqual({
        logGroupName: "/biodome/test-project/test-target",
      });

      const registerCommand = ecsSend.mock.calls[0][0];
      const container = registerCommand.input.containerDefinitions[0];
      expect(container.image).toBe(
        `123456789012.dkr.ecr.us-east-1.amazonaws.com/test-repo@sha256:${"a".repeat(64)}`,
      );
      expect(container.command).toBeUndefined();
    });

    it("continues when the log group already exists", async () => {
      const alreadyExists = Object.assign(new Error("already exists"), {
        name: "ResourceAlreadyExistsException",
      });
      const cwSend = vi.fn().mockRejectedValueOnce(alreadyExists);
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/abc123" }] });
      const driver = createAwsEcsDriver(makeClients({ ecsSend, cwSend }));

      await expect(run(driver.start(makeInput()))).resolves.toMatchObject({
        resourceIds: { taskArn: "arn:aws:ecs:...:task/abc123" },
      });
    });

    it("fails before task startup when log group creation fails", async () => {
      const cwSend = vi.fn().mockRejectedValueOnce(new Error("access denied"));
      const ecsSend = vi.fn();
      const driver = createAwsEcsDriver(makeClients({ ecsSend, cwSend }));

      await expect(run(driver.start(makeInput()))).rejects.toThrow(
        /Failed to create CloudWatch log group.*access denied/,
      );
      expect(ecsSend).not.toHaveBeenCalled();
    });

    it("fails when no task definition ARN is returned", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({ taskDefinition: {} });
      const clients = makeClients({ ecsSend });
      const driver = createAwsEcsDriver(clients);

      await expect(run(driver.start(makeInput()))).rejects.toThrow(RuntimeError);
    });

    it("fails when no task ARN is returned", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({
          tasks: [],
          failures: [{ arn: "x", reason: "InsufficientVCPUs" }],
        });
      const clients = makeClients({ ecsSend });
      const driver = createAwsEcsDriver(clients);

      await expect(run(driver.start(makeInput()))).rejects.toThrow(RuntimeError);
    });
  });

  describe("stop", () => {
    it("sends stop and deregister commands", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "RUNNING" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "STOPPED" }] })
        .mockResolvedValueOnce({});
      const clients = makeClients({ ecsSend });

      const driver = createAwsEcsDriver(clients);
      await run(
        driver.stop(
          makeInput({
            state: makeState({
              taskArn: "arn:aws:ecs:...:task/abc123",
              taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1",
            }),
          }),
        ),
      );
      expect(ecsSend).toHaveBeenCalledTimes(4);
    });

    it("succeeds without stopping when the task is missing", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({
        tasks: [],
        failures: [{ arn: "task", reason: "MISSING" }],
      });

      await expect(
        run(
          createAwsEcsDriver(makeClients({ ecsSend })).stop(
            makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/missing" }) }),
          ),
        ),
      ).resolves.toBeUndefined();
      expect(ecsSend).toHaveBeenCalledTimes(1);
    });

    it("succeeds without stopping when the task is already stopped", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({
        tasks: [{ lastStatus: "STOPPED" }],
      });

      await expect(
        run(
          createAwsEcsDriver(makeClients({ ecsSend })).stop(
            makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/stopped" }) }),
          ),
        ),
      ).resolves.toBeUndefined();
      expect(ecsSend).toHaveBeenCalledTimes(1);
    });

    it("returns RuntimeError when stopping the task fails", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "RUNNING" }] })
        .mockRejectedValueOnce(new Error("stop denied"));

      await expect(
        run(
          createAwsEcsDriver(makeClients({ ecsSend })).stop(
            makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/running" }) }),
          ),
        ),
      ).rejects.toThrow(/Failed to stop ECS task.*stop denied/);
    });

    it("returns RuntimeError when polling the task fails", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "RUNNING" }] })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("poll failed"));

      await expect(
        run(
          createAwsEcsDriver(makeClients({ ecsSend })).stop(
            makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/running" }) }),
          ),
        ),
      ).rejects.toThrow(/Failed to stop ECS task.*poll failed/);
    });

    it("returns RuntimeError when the task does not stop before timeout", async () => {
      vi.useFakeTimers();
      const ecsSend = vi.fn().mockResolvedValue({ tasks: [{ lastStatus: "RUNNING" }] });
      const result = run(
        createAwsEcsDriver(makeClients({ ecsSend })).stop(
          makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/running" }) }),
        ),
      );
      const assertion = expect(result).rejects.toThrow(/Timed out waiting for ECS task/);

      await vi.runAllTimersAsync();
      await assertion;
      vi.useRealTimers();
    });

    it("rejects stopping without validated deployment state", async () => {
      const ecsSend = vi.fn();
      await expect(
        run(createAwsEcsDriver(makeClients({ ecsSend })).stop(makeInput())),
      ).rejects.toThrow(/without validated deployment state/);
      expect(ecsSend).not.toHaveBeenCalled();
    });
  });

  describe("runJob", () => {
    it("registers task, runs, waits for completion, deregisters", async () => {
      process.env.TEST_TASK_ROLE_ARN = "arn:aws:iam::123456789012:role/task";
      try {
        const ecsSend = vi
          .fn()
          .mockResolvedValueOnce({
            taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
          })
          .mockResolvedValueOnce({
            tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }],
            failures: [],
          })
          .mockResolvedValueOnce({ tasks: [{ lastStatus: "RUNNING" }] })
          .mockResolvedValueOnce({
            tasks: [{ lastStatus: "STOPPED", containers: [{ exitCode: 0 }] }],
          })
          .mockResolvedValueOnce({});
        const clients = makeClients({ ecsSend });
        const driver = createAwsEcsDriver(clients);

        const targetWithArtifacts: RuntimeTarget = {
          ...sampleTarget,
          options: {
            ...sampleTarget.options,
            taskRoleArn: { env: "TEST_TASK_ROLE_ARN" },
            artifactBucket: "task-artifacts",
            artifactPrefix: "task-output",
          },
        };
        const result = await run(
          driver.runJob({
            ...makeInput({ target: targetWithArtifacts }),
            command: ["echo", "hello"],
            artifactPaths: ["summary.md"],
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(ecsSend).toHaveBeenCalledTimes(5);
        const registerCommand = ecsSend.mock.calls[0][0];
        expect(registerCommand.input.containerDefinitions[0].image).toBe(
          `123456789012.dkr.ecr.us-east-1.amazonaws.com/test-repo@sha256:${"a".repeat(64)}`,
        );
        expect(registerCommand.input.containerDefinitions[0].environment).toEqual(
          expect.arrayContaining([
            { name: "BIODOME_ARTIFACT_BUCKET", value: "task-artifacts" },
            { name: "BIODOME_ARTIFACT_PREFIX", value: "task-output" },
            { name: "BIODOME_DEPLOYMENT_ID", value: "test-deploy-001" },
            { name: "BIODOME_ARTIFACT_PATHS", value: '["summary.md"]' },
          ]),
        );
      } finally {
        delete process.env.TEST_TASK_ROLE_ARN;
      }
    });

    it("returns a timeout result at the requested deadline", async () => {
      vi.useFakeTimers();
      try {
        const ecsSend = vi
          .fn()
          .mockResolvedValueOnce({
            taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
          })
          .mockResolvedValueOnce({
            tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }],
          })
          .mockResolvedValueOnce({ tasks: [{ lastStatus: "RUNNING" }] })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({});
        const driver = createAwsEcsDriver(makeClients({ ecsSend }));
        const result = run(
          driver.runJob({ ...makeInput(), command: ["sleep", "10"], timeoutMs: 1 }),
        );

        await vi.runAllTimersAsync();

        await expect(result).resolves.toMatchObject({ exitCode: 124, timedOut: true });
        expect(ecsSend).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects artifact tasks without an artifact bucket before cloud calls", async () => {
      const ecsSend = vi.fn();
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await expect(
        run(
          driver.runJob({
            ...makeInput(),
            command: ["echo", "hello"],
            artifactPaths: ["summary.md"],
          }),
        ),
      ).rejects.toThrow(/does not have artifactBucket configured/);
      expect(ecsSend).not.toHaveBeenCalled();
    });

    it("rejects artifact tasks without a task role before cloud calls", async () => {
      const ecsSend = vi.fn();
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));
      const targetWithBucket: RuntimeTarget = {
        ...sampleTarget,
        options: { ...sampleTarget.options, artifactBucket: "task-artifacts" },
      };

      await expect(
        run(
          driver.runJob({
            ...makeInput({ target: targetWithBucket }),
            command: ["echo", "hello"],
            artifactPaths: ["summary.md"],
          }),
        ),
      ).rejects.toThrow(/needs taskRoleArn configured/);
      expect(ecsSend).not.toHaveBeenCalled();
    });
  });

  describe("status", () => {
    it("returns running status for a RUNNING task", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({
        tasks: [{ lastStatus: "RUNNING" }],
      });
      const clients = makeClients({ ecsSend });
      const driver = createAwsEcsDriver(clients);
      const result = await run(
        driver.status(makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/abc" }) })),
      );
      expect(result.state).toBe("running");
    });

    it("rejects status queries without validated deployment state", async () => {
      const driver = createAwsEcsDriver(makeClients());
      await expect(run(driver.status(makeInput()))).rejects.toThrow(
        /without validated deployment state/,
      );
    });
  });

  describe("logs", () => {
    it("fetches log streams and events from CloudWatch", async () => {
      const cwSend = vi
        .fn()
        .mockResolvedValueOnce({
          logStreams: [{ logStreamName: "test-deploy-001/stream1" }],
        })
        .mockResolvedValueOnce({
          events: [
            { timestamp: 1000, message: "hello" },
            { timestamp: 2000, message: "world" },
          ],
        });
      const clients = makeClients({ cwSend });
      const driver = createAwsEcsDriver(clients);

      const result = await run(driver.logs(makeInput()));
      expect(result).toBeUndefined();
      expect(cwSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("collectArtifacts", () => {
    it("returns a failure when artifactBucket is not configured", async () => {
      const driver = createAwsEcsDriver(makeClients());
      await expect(
        run(driver.collectArtifacts({ ...makeInput(), paths: ["/workspace/data"] })),
      ).rejects.toThrow(/does not have artifactBucket configured/);
    });

    it("downloads task artifacts from S3 when artifactBucket is configured", async () => {
      process.env.TEST_ARTIFACT_BUCKET = "my-test-bucket";
      try {
        const s3Send = vi.fn().mockImplementation((_command) => {
          return Promise.resolve({
            Body: {
              transformToByteArray: () => Promise.resolve(new TextEncoder().encode("test content")),
            },
          });
        });
        const clients = {
          ...makeClients(),
          s3: { send: s3Send } as any,
        };
        const driver = createAwsEcsDriver(clients);
        const targetWithS3: RuntimeTarget = {
          ...sampleTarget,
          options: {
            ...sampleTarget.options,
            artifactBucket: { env: "TEST_ARTIFACT_BUCKET" },
            artifactPrefix: "my-artifacts",
          },
        };
        const outputDir = join(tmpdir(), `ecs-artifacts-${randomUUID()}`);
        mkdirSync(outputDir, { recursive: true });
        try {
          const result = await run(
            driver.collectArtifacts({
              ...makeInput({ target: targetWithS3, outputDir }),
              paths: ["summary.md"],
            }),
          );
          expect(result.length).toBe(1);
          expect(result[0].path).toBe("summary.md");
          expect(result[0].sizeBytes).toBe(12);
          expect(s3Send).toHaveBeenCalled();
          const written = readFileSync(join(outputDir, "artifacts", "summary.md"), "utf-8");
          expect(written).toBe("test content");
        } finally {
          rmSync(outputDir, { recursive: true, force: true });
        }
      } finally {
        delete process.env.TEST_ARTIFACT_BUCKET;
      }
    });
  });
});

describe("buildxImageDigest", () => {
  it("reads the immutable OCI digest from Buildx metadata", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(buildxImageDigest(JSON.stringify({ "containerimage.digest": digest }))).toBe(digest);
  });

  it("rejects Buildx metadata without an OCI digest", () => {
    expect(() => buildxImageDigest("{}")).toThrow(/did not return an immutable image digest/);
  });
});
