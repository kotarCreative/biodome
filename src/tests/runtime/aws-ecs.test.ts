import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import {
  buildxImageDigest,
  createAwsEcsDriver,
  materializeContainerEnvironment,
  readArtifactBodyWithinLimit,
  type AwsClients,
} from "../../runtime/aws-ecs.js";
import { validateAwsEcsOptions } from "../../runtime/aws-ecs-schema.js";
import type { RuntimeTarget } from "../../core/plan.js";
import type { Plan } from "../../core/plan.js";
import type { RuntimeOperationInput } from "../../runtime/driver.js";
import type { BuildManifest } from "../../runtime/build-manifest.js";
import { RuntimeError } from "../../core/errors.js";
import { NoOpEventStoreLive, type EventStore } from "../../core/events.js";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runtimeLayout } from "../../runtime/layout.js";
import { statePath, writeState } from "../../runtime/state.js";

// The driver resolves the execution role from the host environment and fails
// fast when it is missing; tests use a stand-in ARN.
process.env.ECS_EXECUTION_ROLE_ARN ??= "arn:aws:iam::123456789012:role/execution";

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
    workspace: { strategy: "upload" },
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
      commandTimeoutMs: 30000,
      commandStdoutMaxBytes: 1048576,
      commandStderrMaxBytes: 1048576,
      maxReadBytes: 1048576,
      maxWriteBytes: 2097152,
      maxListEntries: 100,
      providerConnectTimeoutMs: 10000,
      providerRequestTimeoutMs: 30000,
      providerCatalogConcurrency: 4,
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
    identities: [
      { role: "runtime", user: "biodome", group: "biodome", uid: 10001, gid: 10001 },
      {
        role: "mcp",
        user: "biodome-mcp",
        group: "biodome-mcp",
        uid: 10002,
        gid: 10002,
        supplementaryGroups: ["biodome"],
      },
      { role: "mount", user: "biodome-mount", group: "biodome-mount", uid: 10003, gid: 10003 },
    ],
    envVars: [],
    endpoints: [],
    providers: [],
    repos: [],
    applications: [],
    contributions: [],
  },
};

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REF = `123456789012.dkr.ecr.us-east-1.amazonaws.com/test-repo@${IMAGE_DIGEST}`;

function makeBuildManifest(): BuildManifest {
  return {
    schemaVersion: 1,
    target: sampleTarget.name,
    driver: "aws-ecs",
    deploymentId: "test-deploy-001",
    imageRef: IMAGE_REF,
    digest: IMAGE_DIGEST,
    contentId: "test-content",
    createdAt: new Date().toISOString(),
    provider: {},
  };
}

/** Operation input carrying the manifest that start/job operations require. */
type ManifestBackedInput = RuntimeOperationInput & { buildManifest: BuildManifest };

function makeInput(
  overrides?: Omit<Partial<RuntimeOperationInput>, "buildManifest">,
): ManifestBackedInput {
  return {
    rootDir: "/tmp/root",
    outputDir: "/tmp/output",
    plan: samplePlan,
    target: sampleTarget,
    deploymentId: "test-deploy-001",
    buildManifest: makeBuildManifest(),
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

describe("aws-ecs options schema", () => {
  const base = () => ({
    region: "us-east-1",
    cluster: "c",
    repository: "r",
    executionRoleArn: { env: "ECS_EXECUTION_ROLE_ARN" },
    workspace: { strategy: "upload" },
    subnets: ["subnet-a"],
    securityGroups: ["sg-a"],
  });

  it("accepts the single supported upload workspace strategy", () => {
    const options = validateAwsEcsOptions({ ...base(), workspace: { strategy: "upload" } });
    expect(options.workspace).toEqual({ strategy: "upload" });
  });

  it("requires the upload workspace contract explicitly", () => {
    const { workspace: _workspace, ...withoutWorkspace } = base();
    expect(() => validateAwsEcsOptions(withoutWorkspace)).toThrow(/Missing key.*workspace/s);
  });

  it("rejects unsupported workspace strategies before any AWS call", () => {
    expect(() =>
      validateAwsEcsOptions({ ...base(), workspace: { strategy: "bind" as never } }),
    ).toThrow(/Invalid aws-ecs target options.*upload/s);
    expect(() =>
      validateAwsEcsOptions({ ...base(), workspace: { strategy: "clone" as never } }),
    ).toThrow(/upload/);
  });

  it("rejects the removed ttl option with migration guidance", () => {
    expect(() => validateAwsEcsOptions({ ...base(), ttl: "30m" })).toThrow(
      /no longer accepts the "ttl".*biodome down/s,
    );
  });

  it("accepts only Fargate capacity providers", () => {
    expect(validateAwsEcsOptions({ ...base(), capacityProvider: "FARGATE_SPOT" })).toMatchObject({
      capacityProvider: "FARGATE_SPOT",
    });
    expect(() => validateAwsEcsOptions({ ...base(), capacityProvider: "custom-ec2" })).toThrow(
      /FARGATE.*FARGATE_SPOT/s,
    );
  });

  it("enforces ECS networking array limits", () => {
    expect(() =>
      validateAwsEcsOptions({
        ...base(),
        subnets: Array.from({ length: 17 }, (_, index) => `subnet-${index}`),
      }),
    ).toThrow(/at most 16 subnets/);
    expect(() =>
      validateAwsEcsOptions({
        ...base(),
        securityGroups: Array.from({ length: 6 }, (_, index) => `sg-${index}`),
      }),
    ).toThrow(/at most 5 security groups/);
  });
});

describe("materializeContainerEnvironment", () => {
  it("maps literal plan environment and literal env vars into plaintext entries", () => {
    const plan: Plan = {
      ...samplePlan,
      runtime: {
        ...samplePlan.runtime,
        environment: { B_KEY: "b", A_KEY: "a" },
        envVars: [{ key: "LOG_LEVEL", scope: "runtime", value: "debug" }],
      },
    };
    const result = materializeContainerEnvironment(plan);
    expect(result.environment).toEqual([
      { name: "A_KEY", value: "a" },
      { name: "B_KEY", value: "b" },
      { name: "LOG_LEVEL", value: "debug" },
    ]);
    expect(result.secrets).toEqual([]);
  });

  it("maps AWS secret ARN references to native ECS secrets without resolving values", () => {
    const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:pg";
    const plan: Plan = {
      ...samplePlan,
      runtime: {
        ...samplePlan.runtime,
        envVars: [{ key: "POSTGRES_PASSWORD", scope: "runtime", from: { secretArn: arn } }],
      },
    };
    const result = materializeContainerEnvironment(plan);
    expect(result.secrets).toEqual([{ name: "POSTGRES_PASSWORD", valueFrom: arn }]);
    expect(result.environment).toEqual([]);
  });

  it("fails clearly on secret references outside Secrets Manager and SSM", () => {
    const plan: Plan = {
      ...samplePlan,
      runtime: {
        ...samplePlan.runtime,
        envVars: [
          { key: "KMS_KEY", scope: "runtime", from: { secretArn: "arn:aws:kms:us-east-1::key/1" } },
        ],
      },
    };
    expect(() => materializeContainerEnvironment(plan)).toThrow(
      /KMS_KEY.*unsupported secret reference.*secretsmanager.*ssm/s,
    );
  });

  it("lists every unresolvable host passthrough variable in one failure", () => {
    const plan: Plan = {
      ...samplePlan,
      runtime: {
        ...samplePlan.runtime,
        envVars: [
          { key: "API_TOKEN", scope: "runtime", from: { env: "API_TOKEN" }, required: true },
          { key: "OTHER", scope: "runtime", from: { env: "OTHER" }, required: true },
        ],
      },
    };
    try {
      materializeContainerEnvironment(plan);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).message).toMatch(
        /cannot resolve these environment variables from the host: API_TOKEN, OTHER/,
      );
      // The failure names references, never resolved values.
      expect((error as RuntimeError).message).not.toMatch(/API_TOKEN=|OTHER=/);
    }
  });

  it("omits build-only values and honors optional runtime defaults", () => {
    const plan: Plan = {
      ...samplePlan,
      runtime: {
        ...samplePlan.runtime,
        envVars: [
          { key: "BUILD_TOKEN", scope: "build", value: "not-runtime" },
          { key: "OPTIONAL", scope: "runtime", from: { env: "OPTIONAL" }, required: false },
          {
            key: "WITH_DEFAULT",
            scope: "runtime",
            from: { env: "WITH_DEFAULT" },
            required: false,
            default: "safe-default",
          },
          {
            key: "GOV_SECRET",
            scope: "runtime",
            from: { secretArn: "arn:aws-us-gov:ssm:us-gov-west-1:123456789012:parameter/token" },
          },
        ],
      },
    };

    expect(materializeContainerEnvironment(plan)).toEqual({
      environment: [{ name: "WITH_DEFAULT", value: "safe-default" }],
      secrets: [
        {
          name: "GOV_SECRET",
          valueFrom: "arn:aws-us-gov:ssm:us-gov-west-1:123456789012:parameter/token",
        },
      ],
    });
  });
});

describe("createAwsEcsDriver", () => {
  describe("id and capabilities", () => {
    const driver = createAwsEcsDriver(makeClients());

    it("has the correct driver id", () => {
      expect(driver.id).toBe("aws-ecs");
    });

    it("advertises the job execution path, never in-place exec", () => {
      const caps = driver.capabilities;
      expect(caps).toContain("lifecycle.build");
      expect(caps).toContain("lifecycle.start");
      expect(caps).toContain("lifecycle.stop");
      expect(caps).toContain("status.read");
      expect(caps).toContain("logs.stream");
      expect(caps).toContain("job.run");
      expect(caps).toContain("artifact.collect");
      expect(caps).not.toContain("exec.inplace");
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
            // A deployed ECS target plan drives the workspace COPY emission.
            plan: {
              ...samplePlan,
              deployment: {
                target: sampleTarget,
                deploymentId: "test-deploy-001",
              },
            },
            target: sampleTarget,
          }),
        );
        expect(result).toContain(join(outputDir, "Dockerfile"));
        expect(result.length).toBeGreaterThan(1);
        const dockerfile = readFileSync(join(outputDir, "Dockerfile"), "utf-8");
        // Remote targets materialize the uploaded workspace inside the image.
        expect(dockerfile).toContain("COPY . /workspace/");
        expect(dockerfile).toContain(
          "COPY .biodome-build/targets/test-target/ /workspace/.biodome-build/",
        );
        expect(readFileSync(`${join(outputDir, "Dockerfile")}.dockerignore`, "utf-8")).toContain(
          ".env",
        );
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("uses a target-specific ignore file even when the repository owns .dockerignore", () => {
      const rootDir = join(tmpdir(), `ecs-ignore-${randomUUID()}`);
      const outputDir = runtimeLayout(rootDir, sampleTarget.name).host.root;
      mkdirSync(rootDir, { recursive: true });
      writeFileSync(join(rootDir, ".dockerignore"), "# project-owned\n");
      try {
        const driver = createAwsEcsDriver(makeClients());
        Effect.runSync(
          driver.render({
            rootDir,
            outputDir,
            plan: {
              ...samplePlan,
              deployment: { target: sampleTarget, deploymentId: "test-deploy-001" },
            },
            target: sampleTarget,
          }),
        );

        expect(readFileSync(join(rootDir, ".dockerignore"), "utf-8")).toBe("# project-owned\n");
        const targetIgnore = readFileSync(`${join(outputDir, "Dockerfile")}.dockerignore`, "utf-8");
        expect(targetIgnore).toContain(".env");
        expect(targetIgnore).toContain("node_modules");
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("rejects plans with host-env passthrough variables before writing artifacts", () => {
      const driver = createAwsEcsDriver(makeClients());
      const planWithPassthrough: Plan = {
        ...samplePlan,
        runtime: {
          ...samplePlan.runtime,
          environment: { BIODOME_RUNTIME_UID: "0", BIODOME_RUNTIME_GID: "0" },
          envVars: [
            { key: "API_TOKEN", scope: "runtime", from: { env: "API_TOKEN" }, required: true },
          ],
        },
      };
      expect(() =>
        Effect.runSync(
          driver.render({
            rootDir: "/tmp/root",
            outputDir: "/tmp/output",
            plan: planWithPassthrough,
            target: sampleTarget,
          }),
        ),
      ).toThrow(/cannot resolve these environment variables.*API_TOKEN.*secretArn/s);
    });

    it("renders plans whose env vars use AWS secret ARN references", () => {
      const driver = createAwsEcsDriver(makeClients());
      const planWithArnRef: Plan = {
        ...samplePlan,
        runtime: {
          ...samplePlan.runtime,
          envVars: [
            {
              key: "API_TOKEN",
              scope: "runtime",
              from: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:api-token" },
            },
          ],
        },
      };
      expect(() =>
        Effect.runSync(
          driver.render({
            rootDir: "/tmp/root",
            outputDir: "/tmp/output",
            plan: planWithArnRef,
            target: sampleTarget,
          }),
        ),
      ).not.toThrow();
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
                environment: {},
                ports: [],
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
    function runningDescribe() {
      return { tasks: [{ lastStatus: "RUNNING", healthStatus: "HEALTHY" }] };
    }

    it("registers a hardened task definition, runs a task, waits for RUNNING", async () => {
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
        })
        .mockImplementationOnce(() => {
          calls.push("describe-tasks");
          return Promise.resolve(runningDescribe());
        });
      const clients = makeClients({ ecsSend, cwSend });
      const driver = createAwsEcsDriver(clients);

      const rootDir = join(tmpdir(), `ecs-start-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      try {
        const result = await run(driver.start(makeInput({ rootDir })));

        expect(result.driver).toBe("aws-ecs");
        expect(result.deploymentId).toBe("test-deploy-001");
        expect(result.status).toBe("running");
        expect(result.resourceIds.taskDefinitionArn).toBe("arn:aws:ecs:...:task-def/test-deploy:1");
        expect(result.resourceIds.taskArn).toBe("arn:aws:ecs:...:task/abc123");
        expect(result.resourceIds.logGroup).toBe("/biodome/test-project/test-target");
        expect(result.resourceIds.logStreamPrefix).toBe("test-deploy-001");

        expect(calls).toEqual([
          "create-log-group",
          "register-task-definition",
          "run-task",
          "describe-tasks",
        ]);

        const registerCommand = ecsSend.mock.calls[0][0];
        expect(registerCommand.input.requiresCompatibilities).toEqual(["FARGATE"]);
        expect(registerCommand.input.networkMode).toBe("awsvpc");
        const container = registerCommand.input.containerDefinitions[0];
        // The exact immutable image built for this run is what gets registered.
        expect(container.image).toBe(IMAGE_REF);
        // Non-root workload identity; no privileged mode; bounded filesystem.
        expect(container.user).toBe("10001:10001");
        expect(container.privileged).toBe(false);
        expect(container.readonlyRootFilesystem).toBe(false);
        expect(container.linuxParameters.initProcessEnabled).toBe(true);
        expect(container.linuxParameters.capabilities).toEqual({ drop: ["ALL"] });
        expect(registerCommand.input.portMappings).toBeUndefined();
        expect(container.command).toEqual([
          "sh",
          "-c",
          "rm -f /workspace/.biodome-build/targets/test-target/ready && touch /workspace/.biodome-build/targets/test-target/ready && exec sleep infinity",
        ]);
        expect(container.healthCheck.command).toEqual([
          "CMD-SHELL",
          "test -f /workspace/.biodome-build/targets/test-target/ready",
        ]);
        const runCommand = ecsSend.mock.calls[1][0];
        expect(runCommand.input.clientToken).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("keeps the supervisor model (root init) only when daemon processes exist", async () => {
      const daemonPlan: Plan = {
        ...samplePlan,
        runtime: {
          ...samplePlan.runtime,
          processes: [
            {
              name: "postgres",
              command: ["postgres"],
              mode: "daemon",
              bootstrap: false,
              environment: {},
              healthCheck: undefined,
              workingDir: undefined,
              startOn: "start.post",
            } as never,
          ],
        },
      };
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/abc123" }] })
        .mockResolvedValueOnce(runningDescribe());
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await run(driver.start(makeInput({ plan: daemonPlan })));

      const container = ecsSend.mock.calls[0][0].input.containerDefinitions[0];
      // supervisord initializes as root and setpriv-drops workloads (Plan 04).
      expect(container.user).toBeUndefined();
      expect(container.command).toEqual([
        "sh",
        "/workspace/.biodome-build/targets/test-target/startup.sh",
      ]);
      expect(container.environment).toEqual(
        expect.arrayContaining([
          { name: "BIODOME_RUNTIME_UID", value: "10001" },
          { name: "BIODOME_RUNTIME_GID", value: "10001" },
        ]),
      );
    });

    it("does not launch startup.sh for hooks that do not run at container start", async () => {
      const plan: Plan = {
        ...samplePlan,
        runtime: {
          ...samplePlan.runtime,
          processes: [
            {
              name: "build-check",
              command: ["true"],
              mode: "oneshot",
              startOn: "build.pre",
              environment: {},
              ports: [],
            },
          ],
        },
      };
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/abc123" }] })
        .mockResolvedValueOnce(runningDescribe());
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await run(driver.start(makeInput({ plan })));

      const container = ecsSend.mock.calls[0][0].input.containerDefinitions[0];
      expect(container.user).toBe("10001:10001");
      expect(container.command).not.toContain("startup.sh");
    });

    it("sanitizes invalid project characters in CloudWatch log group names", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/abc123" }] })
        .mockResolvedValueOnce(runningDescribe());
      const cwSend = vi.fn().mockResolvedValue({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend, cwSend }));

      await run(
        driver.start(makeInput({ plan: { ...samplePlan, project: "project with spaces?" } })),
      );

      const logGroupName = cwSend.mock.calls[0][0].input.logGroupName as string;
      expect(logGroupName).toMatch(/^\/biodome\/project-with-spaces--[a-f0-9]{12}\/test-target$/);
    });

    it("persists provisional state before waiting and final state after RUNNING", async () => {
      const rootDir = join(tmpdir(), `ecs-state-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      try {
        let stateAtFirstProbe: Record<string, unknown> | undefined;
        const ecsSend = vi
          .fn()
          .mockResolvedValueOnce({
            taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
          })
          .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/prov-1" }] })
          .mockImplementationOnce(() => {
            const raw = readFileSync(statePath(rootDir, sampleTarget.name), "utf-8");
            stateAtFirstProbe = JSON.parse(raw) as Record<string, unknown>;
            return Promise.resolve({ tasks: [{ lastStatus: "PENDING" }] });
          })
          .mockResolvedValueOnce(runningDescribe());
        const driver = createAwsEcsDriver(makeClients({ ecsSend }));

        await run(driver.start(makeInput({ rootDir })));

        const provisional = stateAtFirstProbe ?? {};
        expect(provisional.status).toBe("provisioning");
        const provisionalIds = provisional.resourceIds as Record<string, string>;
        expect(provisionalIds.taskArn).toBe("arn:aws:ecs:...:task/prov-1");
        expect(provisionalIds.taskDefinitionArn).toBe("arn:aws:ecs:...:task-def/test-deploy:1");

        const finalRaw = JSON.parse(
          readFileSync(statePath(rootDir, sampleTarget.name), "utf-8"),
        ) as Record<string, unknown>;
        expect(finalRaw.status).toBe("running");
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("polls through PENDING until RUNNING with an injectable policy", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/poll-1" }] })
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "PROVISIONING" }] })
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "PENDING" }] })
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "RUNNING", healthStatus: "UNKNOWN" }] })
        .mockResolvedValueOnce(runningDescribe());
      const driver = createAwsEcsDriver(makeClients({ ecsSend }), {
        intervalMs: 1,
        timeoutMs: 10_000,
      });

      await expect(run(driver.start(makeInput()))).resolves.toMatchObject({
        resourceIds: { taskArn: "arn:aws:ecs:...:task/poll-1" },
        status: "running",
      });
      expect(ecsSend).toHaveBeenCalledTimes(6);
    });

    it("retries transient startup polling errors", async () => {
      const throttled = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/retry-1" }] })
        .mockRejectedValueOnce(throttled)
        .mockResolvedValueOnce(runningDescribe());
      const driver = createAwsEcsDriver(makeClients({ ecsSend }), {
        intervalMs: 1,
        timeoutMs: 10_000,
      });

      await expect(run(driver.start(makeInput()))).resolves.toMatchObject({ status: "running" });
      expect(ecsSend).toHaveBeenCalledTimes(4);
    });

    it("fails distinctly when RunTask reports placement failures and rolls back", async () => {
      const rootDir = join(tmpdir(), `ecs-fail-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({
          tasks: [],
          failures: [{ arn: "x", reason: "InsufficientVCPUs", detail: "not enough vCPU capacity" }],
        })
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      try {
        await expect(run(driver.start(makeInput({ rootDir })))).rejects.toThrow(
          /RunTask failed to place the task.*InsufficientVCPUs \(not enough vCPU capacity\)/s,
        );
        // Rollback deregisters; no DescribeTasks polling ever happened.
        expect(ecsSend).toHaveBeenCalledTimes(4);
        expect(ecsSend.mock.calls[2][0].constructor.name).toBe("DeregisterTaskDefinitionCommand");
        expect(ecsSend.mock.calls[3][0].constructor.name).toBe("DeleteTaskDefinitionsCommand");
        expect(existsSync(statePath(rootDir, sampleTarget.name))).toBe(false);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("stops and deregisters everything when the task dies before RUNNING", async () => {
      const rootDir = join(tmpdir(), `ecs-died-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/died-1" }] })
        .mockResolvedValueOnce({
          tasks: [
            {
              lastStatus: "STOPPED",
              stopCode: "EssentialContainerExited",
              stoppedReason: "Fargate task exited",
              containers: [{ name: "dev", exitCode: 1 }],
            },
          ],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      try {
        await expect(run(driver.start(makeInput({ rootDir })))).rejects.toThrow(
          /terminal failure before becoming usable.*EssentialContainerExited.*exited 1/s,
        );
        expect(ecsSend).toHaveBeenCalledTimes(6);
        expect(ecsSend.mock.calls[3][0].constructor.name).toBe("StopTaskCommand");
        expect(ecsSend.mock.calls[4][0].constructor.name).toBe("DeregisterTaskDefinitionCommand");
        expect(ecsSend.mock.calls[5][0].constructor.name).toBe("DeleteTaskDefinitionsCommand");
        expect(existsSync(statePath(rootDir, sampleTarget.name))).toBe(false);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("times out on a bounded poll and rolls back all resources", async () => {
      vi.useFakeTimers();
      const rootDir = join(tmpdir(), `ecs-timeout-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      try {
        const ecsSend = vi
          .fn()
          .mockResolvedValueOnce({
            taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
          })
          .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/slow-1" }] })
          .mockResolvedValue({ tasks: [{ lastStatus: "PENDING" }] });
        const driver = createAwsEcsDriver(makeClients({ ecsSend }), {
          intervalMs: 1_000,
          timeoutMs: 5_000,
        });

        const outcome = run(driver.start(makeInput({ rootDir })));
        const assertion = expect(outcome).rejects.toThrow(
          /Timed out after 5s waiting for ECS task .* \(last status PENDING\)/,
        );

        await vi.runAllTimersAsync();
        await assertion;

        const commands = ecsSend.mock.calls.map((call) => call[0].constructor.name);
        expect(commands.slice(-3)).toEqual([
          "StopTaskCommand",
          "DeregisterTaskDefinitionCommand",
          "DeleteTaskDefinitionsCommand",
        ]);
        expect(existsSync(statePath(rootDir, sampleTarget.name))).toBe(false);
      } finally {
        vi.useRealTimers();
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("places tasks through a configured capacity provider (e.g. Fargate Spot)", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/spot-1" }] })
        .mockResolvedValueOnce(runningDescribe());
      const spotTarget: RuntimeTarget = {
        ...sampleTarget,
        options: { ...sampleTarget.options, capacityProvider: "FARGATE_SPOT" },
      };
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await expect(run(driver.start(makeInput({ target: spotTarget })))).resolves.toMatchObject({
        status: "running",
      });

      const runTask = ecsSend.mock.calls[1][0];
      expect(runTask.input.capacityProviderStrategy).toEqual([
        { capacityProvider: "FARGATE_SPOT", weight: 1 },
      ]);
      expect(runTask.input.launchType).toBeUndefined();
    });

    it("classifies authorization failures distinctly at registration", async () => {
      const denied = Object.assign(new Error("not authorized"), {
        name: "AccessDeniedException",
      });
      const ecsSend = vi.fn().mockRejectedValueOnce(denied);
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await expect(run(driver.start(makeInput()))).rejects.toThrow(
        /AWS authorization failed while registering ECS task definition.*IAM permissions.*not authorized/s,
      );
      expect(ecsSend).toHaveBeenCalledTimes(1);
    });

    it("discovers and persists a task definition after a lost registration response", async () => {
      const rootDir = join(tmpdir(), `ecs-lost-register-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      const lostResponse = new Error("socket hang up after registration");
      const denied = Object.assign(new Error("delete denied"), { name: "AccessDeniedException" });
      const discoveredArn =
        "arn:aws:ecs:us-east-1:123456789012:task-definition/biodome-test-deploy-001:7";
      const ecsSend = vi
        .fn()
        .mockRejectedValueOnce(lostResponse)
        .mockResolvedValueOnce({ taskArns: [] })
        .mockResolvedValueOnce({ taskArns: [] })
        .mockResolvedValueOnce({ taskDefinitionArns: [discoveredArn] })
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: discoveredArn, status: "INACTIVE" },
        })
        .mockRejectedValueOnce(denied);
      const driver = createAwsEcsDriver(makeClients({ ecsSend }), { intervalMs: 1 });

      try {
        await expect(run(driver.start(makeInput({ rootDir })))).rejects.toThrow(
          /AWS transport error while registering ECS task definition/,
        );
        expect(ecsSend.mock.calls.map((call) => call[0].constructor.name)).toEqual([
          "RegisterTaskDefinitionCommand",
          "ListTasksCommand",
          "ListTasksCommand",
          "ListTaskDefinitionsCommand",
          "DeregisterTaskDefinitionCommand",
          "DeleteTaskDefinitionsCommand",
        ]);
        expect(ecsSend.mock.calls[1][0].input.desiredStatus).toBe("RUNNING");
        expect(ecsSend.mock.calls[2][0].input.desiredStatus).toBe("STOPPED");
        const state = JSON.parse(
          readFileSync(statePath(rootDir, sampleTarget.name), "utf-8"),
        ) as NonNullable<RuntimeOperationInput["state"]>;
        expect(state.status).toBe("failed");
        expect(state.resourceIds.taskDefinitionArn).toBe(discoveredArn);
        expect(state.resourceIds.taskDefinitionFamily).toBe("biodome-test-deploy-001");
        expect(state.resourceIds.taskLaunchMayExist).toBeUndefined();

        const cleanupSend = vi
          .fn()
          .mockResolvedValueOnce({
            taskDefinition: { taskDefinitionArn: discoveredArn, status: "INACTIVE" },
          })
          .mockResolvedValueOnce({
            taskDefinitions: [{ taskDefinitionArn: discoveredArn, status: "DELETE_IN_PROGRESS" }],
            failures: [],
          });
        await run(
          createAwsEcsDriver(makeClients({ ecsSend: cleanupSend })).stop(
            makeInput({ rootDir, state }),
          ),
        );
        expect(cleanupSend.mock.calls.map((call) => call[0].constructor.name)).toEqual([
          "DeregisterTaskDefinitionCommand",
          "DeleteTaskDefinitionsCommand",
        ]);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("discovers and persists a task after a lost RunTask response", async () => {
      const rootDir = join(tmpdir(), `ecs-lost-run-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      const definitionArn =
        "arn:aws:ecs:us-east-1:123456789012:task-definition/biodome-test-deploy-001:8";
      const taskArn = "arn:aws:ecs:us-east-1:123456789012:task/test-cluster/lost-run";
      const denied = Object.assign(new Error("stop denied"), { name: "AccessDeniedException" });
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({ taskDefinition: { taskDefinitionArn: definitionArn } })
        .mockRejectedValueOnce(new Error("ECONNRESET after task placement"))
        .mockResolvedValueOnce({ taskArns: [taskArn] })
        .mockResolvedValueOnce({ taskArns: [] })
        .mockResolvedValueOnce({ taskDefinitionArns: [definitionArn] })
        .mockRejectedValueOnce(denied)
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: definitionArn, status: "INACTIVE" },
        })
        .mockResolvedValueOnce({
          taskDefinitions: [{ taskDefinitionArn: definitionArn, status: "DELETE_IN_PROGRESS" }],
          failures: [],
        });
      const driver = createAwsEcsDriver(makeClients({ ecsSend }), { intervalMs: 1 });

      try {
        await expect(run(driver.start(makeInput({ rootDir })))).rejects.toThrow(
          /AWS transport error while starting ECS task/,
        );
        expect(ecsSend.mock.calls[1][0].input.clientToken).toMatch(/^[a-f0-9]{64}$/);
        expect(ecsSend.mock.calls.map((call) => call[0].constructor.name).slice(2)).toEqual([
          "ListTasksCommand",
          "ListTasksCommand",
          "ListTaskDefinitionsCommand",
          "StopTaskCommand",
          "DeregisterTaskDefinitionCommand",
          "DeleteTaskDefinitionsCommand",
        ]);
        const state = JSON.parse(readFileSync(statePath(rootDir, sampleTarget.name), "utf-8")) as {
          status: string;
          resourceIds: Record<string, string>;
        };
        expect(state.status).toBe("failed");
        expect(state.resourceIds).toMatchObject({ taskArn, taskDefinitionArn: definitionArn });
        expect(state.resourceIds.taskLaunchMayExist).toBe("true");
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("registers AWS secret ARN references as native secrets, not plaintext env", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/abc123" }] })
        .mockResolvedValueOnce(runningDescribe());
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));
      const input = makeInput();
      const arnPlan: Plan = {
        ...input.plan,
        runtime: {
          ...input.plan.runtime,
          environment: { ...input.plan.runtime.environment, LOG_LEVEL: "debug" },
          envVars: [
            ...input.plan.runtime.envVars,
            {
              key: "POSTGRES_PASSWORD",
              scope: "runtime",
              from: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:pg-1" },
            },
            {
              key: "API_TOKEN",
              scope: "runtime",
              from: { secretArn: "arn:aws:ssm:us-east-1:123456789012:parameter/api/token" },
            },
          ],
        },
      };

      await run(driver.start({ ...input, plan: arnPlan }));

      const container = ecsSend.mock.calls[0][0].input.containerDefinitions[0];
      // Literals stay in the plaintext environment map...
      expect(container.environment).toEqual(
        expect.arrayContaining([{ name: "LOG_LEVEL", value: "debug" }]),
      );
      expect(container.environment).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "POSTGRES_PASSWORD" })]),
      );
      // ...while ARN references are injected natively by ECS (key-sorted).
      expect(container.secrets).toEqual([
        { name: "API_TOKEN", valueFrom: "arn:aws:ssm:us-east-1:123456789012:parameter/api/token" },
        {
          name: "POSTGRES_PASSWORD",
          valueFrom: "arn:aws:secretsmanager:us-east-1:123456789012:secret:pg-1",
        },
      ]);
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
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/abc123" }] })
        .mockResolvedValueOnce(runningDescribe());
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
        /creating CloudWatch log group.*access denied/,
      );
      expect(ecsSend).not.toHaveBeenCalled();
    });

    it("fails when no task definition ARN is returned", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({ taskDefinition: {} });
      const clients = makeClients({ ecsSend });
      const driver = createAwsEcsDriver(clients);

      await expect(run(driver.start(makeInput()))).rejects.toThrow(RuntimeError);
    });

    it("deregisters the task definition when RunTask throws", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockRejectedValueOnce(new Error("subnet not found"))
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await expect(run(driver.start(makeInput()))).rejects.toThrow(
        /while starting ECS task from.*subnet not found/s,
      );
      expect(ecsSend).toHaveBeenCalledTimes(4);
      expect(ecsSend.mock.calls[2][0].input.taskDefinition).toBe(
        "arn:aws:ecs:...:task-def/test-deploy:1",
      );
    });

    it("rejects a mutable fallback before making AWS calls", async () => {
      const ecsSend = vi.fn();
      const cwSend = vi.fn();
      const driver = createAwsEcsDriver(makeClients({ ecsSend, cwSend }));
      const buildManifest = { ...makeBuildManifest(), imageRef: undefined };

      await expect(run(driver.start({ ...makeInput(), buildManifest }))).rejects.toThrow(
        /requires a build manifest with an immutable repository@sha256 image reference/,
      );
      expect(ecsSend).not.toHaveBeenCalled();
      expect(cwSend).not.toHaveBeenCalled();
    });

    it("retains failed recovery state when rollback cannot stop the task", async () => {
      const rootDir = join(tmpdir(), `ecs-recovery-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      const denied = Object.assign(new Error("stop denied"), { name: "AccessDeniedException" });
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/recover-1" }] })
        .mockResolvedValueOnce({
          tasks: [
            {
              lastStatus: "STOPPED",
              stopCode: "TaskFailedToStart",
              stoppedReason: "failed",
            },
          ],
        })
        .mockRejectedValueOnce(denied)
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      try {
        await expect(run(driver.start(makeInput({ rootDir })))).rejects.toThrow(
          /TaskFailedToStart/,
        );
        const state = JSON.parse(
          readFileSync(statePath(rootDir, sampleTarget.name), "utf-8"),
        ) as Record<string, unknown>;
        expect(state.status).toBe("failed");
        expect(state.resourceIds).toMatchObject({
          taskArn: "arn:aws:ecs:...:task/recover-1",
          taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1",
        });
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe("stop", () => {
    it("sends stop and deregister commands", async () => {
      const definitionArn = "arn:aws:ecs:...:task-def/test-deploy:1";
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "RUNNING" }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ tasks: [{ lastStatus: "STOPPED" }] })
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: definitionArn, status: "INACTIVE" },
        })
        .mockResolvedValueOnce({
          taskDefinitions: [{ taskDefinitionArn: definitionArn, status: "DELETE_IN_PROGRESS" }],
          failures: [],
        });
      const clients = makeClients({ ecsSend });

      const driver = createAwsEcsDriver(clients);
      await run(
        driver.stop(
          makeInput({
            state: makeState({
              taskArn: "arn:aws:ecs:...:task/abc123",
              taskDefinitionArn: definitionArn,
            }),
          }),
        ),
      );
      expect(ecsSend).toHaveBeenCalledTimes(5);
      expect(ecsSend.mock.calls.map((call) => call[0].constructor.name).slice(-2)).toEqual([
        "DeregisterTaskDefinitionCommand",
        "DeleteTaskDefinitionsCommand",
      ]);
    });

    it("is idempotent when only an interrupted-start record exists", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await expect(
        run(
          driver.stop(
            makeInput({
              state: makeState({
                taskDefinitionArn: "arn:aws:ecs:...:task-def/test-deploy:1",
              }),
            }),
          ),
        ),
      ).resolves.toBeUndefined();
      expect(ecsSend).toHaveBeenCalledTimes(2);
      expect(ecsSend.mock.calls[0][0].constructor.name).toBe("DeregisterTaskDefinitionCommand");
      expect(ecsSend.mock.calls[1][0].constructor.name).toBe("DeleteTaskDefinitionsCommand");
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
      ).rejects.toThrow(/stopping ECS task.*stop denied/s);
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
      ).rejects.toThrow(/querying ECS task.*poll failed/s);
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
    it("registers a non-root one-shot task, runs, waits for completion, deregisters", async () => {
      process.env.TEST_TASK_ROLE_ARN = "arn:aws:iam::123456789012:role/task";
      try {
        const definitionArn = "arn:aws:ecs:...:task-def/exec:1";
        const ecsSend = vi
          .fn()
          .mockResolvedValueOnce({
            taskDefinition: { taskDefinitionArn: definitionArn },
          })
          .mockResolvedValueOnce({
            tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }],
            failures: [],
          })
          .mockResolvedValueOnce({ tasks: [{ lastStatus: "RUNNING" }] })
          .mockResolvedValueOnce({
            tasks: [{ lastStatus: "STOPPED", containers: [{ exitCode: 0 }] }],
          })
          .mockResolvedValueOnce({
            taskDefinition: { taskDefinitionArn: definitionArn, status: "INACTIVE" },
          })
          .mockResolvedValueOnce({
            taskDefinitions: [{ taskDefinitionArn: definitionArn, status: "DELETE_IN_PROGRESS" }],
            failures: [],
          });
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
        expect(ecsSend).toHaveBeenCalledTimes(6);
        expect(ecsSend.mock.calls.map((call) => call[0].constructor.name).slice(-2)).toEqual([
          "DeregisterTaskDefinitionCommand",
          "DeleteTaskDefinitionsCommand",
        ]);

        const registerCommand = ecsSend.mock.calls[0][0];
        const container = registerCommand.input.containerDefinitions[0];
        expect(container.image).toBe(IMAGE_REF);
        // One-shot job commands are plain non-root workloads.
        expect(container.user).toBe("10001:10001");
        expect(container.privileged).toBe(false);
        expect(container.command).toEqual([
          "sh",
          "-c",
          [
            "job_status=0",
            '"$@" || job_status=$?',
            'if [ "$job_status" -eq 0 ]; then',
            '  aws s3 cp /workspace/summary.md "s3://${BIODOME_ARTIFACT_BUCKET}/${BIODOME_ARTIFACT_PREFIX}/${BIODOME_DEPLOYMENT_ID}/"summary.md --only-show-errors || job_status=$?',
            "fi",
            'exit "$job_status"',
          ].join("\n"),
          "biodome-artifact-job",
          "echo",
          "hello",
        ]);
        expect(container.logConfiguration.options["awslogs-stream-prefix"]).toBe(
          "test-deploy-001-exec",
        );
        expect(container.environment).toEqual(
          expect.arrayContaining([
            { name: "AWS_REGION", value: "us-east-1" },
            { name: "AWS_DEFAULT_REGION", value: "us-east-1" },
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

    it("keeps the configured task role on jobs without artifacts", async () => {
      process.env.TEST_TASK_ROLE_ARN = "arn:aws:iam::123456789012:role/task";
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockResolvedValueOnce({
          tasks: [{ lastStatus: "STOPPED", containers: [{ name: "dev", exitCode: 0 }] }],
        })
        .mockResolvedValueOnce({});
      const target: RuntimeTarget = {
        ...sampleTarget,
        options: { ...sampleTarget.options, taskRoleArn: { env: "TEST_TASK_ROLE_ARN" } },
      };

      try {
        const driver = createAwsEcsDriver(makeClients({ ecsSend }));
        await run(driver.runJob({ ...makeInput({ target }), command: ["echo", "hello"] }));
        expect(ecsSend.mock.calls[0][0].input.taskRoleArn).toBe(
          "arn:aws:iam::123456789012:role/task",
        );
      } finally {
        delete process.env.TEST_TASK_ROLE_ARN;
      }
    });

    it("persists job resource identity until cleanup succeeds", async () => {
      const rootDir = join(tmpdir(), `ecs-job-state-${randomUUID()}`);
      mkdirSync(rootDir, { recursive: true });
      const state = makeState({
        taskArn: "arn:aws:ecs:...:task/base",
        taskDefinitionArn: "arn:aws:ecs:...:task-def/base:1",
      });
      if (!state) throw new Error("Expected test deployment state");
      writeState(rootDir, sampleTarget.name, state);
      let stateDuringJob: Record<string, unknown> | undefined;
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockImplementationOnce(() => {
          stateDuringJob = JSON.parse(
            readFileSync(statePath(rootDir, sampleTarget.name), "utf-8"),
          ) as Record<string, unknown>;
          return Promise.resolve({
            tasks: [{ lastStatus: "STOPPED", containers: [{ name: "dev", exitCode: 0 }] }],
          });
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      try {
        await run(driver.runJob({ ...makeInput({ rootDir, state }), command: ["true"] }));
        expect(stateDuringJob?.resourceIds).toMatchObject({
          jobTaskArn: "arn:aws:ecs:...:task/exec-123",
          jobTaskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1",
        });
        const restored = JSON.parse(
          readFileSync(statePath(rootDir, sampleTarget.name), "utf-8"),
        ) as { resourceIds: Record<string, string> };
        expect(restored.resourceIds.jobTaskArn).toBeUndefined();
        expect(restored.resourceIds.taskArn).toBe("arn:aws:ecs:...:task/base");
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it("starts declared daemons in the job task and then drops identity for the command", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockResolvedValueOnce({
          tasks: [{ lastStatus: "STOPPED", containers: [{ name: "dev", exitCode: 0 }] }],
        })
        .mockResolvedValueOnce({});
      const plan: Plan = {
        ...samplePlan,
        runtime: {
          ...samplePlan.runtime,
          processes: [
            {
              name: "postgres",
              command: ["postgres"],
              mode: "daemon",
              bootstrap: true,
              environment: {},
              ports: [],
              startOn: "start.post",
            },
          ],
        },
      };
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await run(driver.runJob({ ...makeInput({ plan }), command: ["sh", "-c", "echo ready"] }));

      const container = ecsSend.mock.calls[0][0].input.containerDefinitions[0];
      expect(container.user).toBeUndefined();
      expect(container.command).toEqual([
        "sh",
        "/workspace/.biodome-build/targets/test-target/startup.sh",
        "--job",
        "sh",
        "-c",
        "echo ready",
      ]);
      expect(container.linuxParameters.capabilities).toEqual({
        drop: [
          "AUDIT_WRITE",
          "FSETID",
          "KILL",
          "MKNOD",
          "NET_BIND_SERVICE",
          "NET_RAW",
          "SETFCAP",
          "SETPCAP",
          "SYS_CHROOT",
        ],
      });
    });

    it("runs validation commands in the same one-shot task after the workload", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockResolvedValueOnce({
          tasks: [{ lastStatus: "STOPPED", containers: [{ name: "dev", exitCode: 0 }] }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await run(
        driver.runJob({
          ...makeInput(),
          command: ["sh", "-c", "printf changed > changed.txt"],
          validationCommands: [
            ["test", "-f", "changed.txt"],
            ["sh", "-c", "grep changed changed.txt"],
          ],
        }),
      );

      const command = ecsSend.mock.calls[0][0].input.containerDefinitions[0].command;
      expect(command.slice(-3)).toEqual(["sh", "-c", "printf changed > changed.txt"]);
      expect(command[2]).toContain('"$@"');
      expect(command[2]).toContain("if ! test -f changed.txt; then");
      expect(command[2]).toContain("if ! sh -c 'grep changed changed.txt'; then");
      expect(command[2]).not.toContain("printf changed > changed.txt");

      const workspace = mkdtempSync(join(tmpdir(), "biodome-ecs-validation-"));
      try {
        const executed = spawnSync(command[0], command.slice(1), {
          cwd: workspace,
          encoding: "utf-8",
        });
        expect(executed.status, executed.stderr).toBe(0);
        expect(readFileSync(join(workspace, "changed.txt"), "utf-8")).toBe("changed");
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("wraps daemon-backed jobs with automatic artifact upload without interpolating argv", async () => {
      process.env.TEST_TASK_ROLE_ARN = "arn:aws:iam::123456789012:role/task";
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockResolvedValueOnce({
          tasks: [{ lastStatus: "STOPPED", containers: [{ name: "dev", exitCode: 0 }] }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      const plan: Plan = {
        ...samplePlan,
        runtime: {
          ...samplePlan.runtime,
          processes: [
            {
              name: "postgres",
              command: ["postgres"],
              mode: "daemon",
              bootstrap: true,
              environment: {},
              ports: [],
              startOn: "start.post",
            },
          ],
        },
      };
      const target: RuntimeTarget = {
        ...sampleTarget,
        options: {
          ...sampleTarget.options,
          taskRoleArn: { env: "TEST_TASK_ROLE_ARN" },
          artifactBucket: "task-artifacts",
        },
      };

      try {
        const driver = createAwsEcsDriver(makeClients({ ecsSend }));
        await run(
          driver.runJob({
            ...makeInput({ plan, target }),
            command: ["sh", "-c", "printf %s '$TOKEN' > 'proof file.txt'"],
            artifactPaths: ["proof file.txt"],
          }),
        );

        const command = ecsSend.mock.calls[0][0].input.containerDefinitions[0].command;
        expect(command.slice(-6)).toEqual([
          "sh",
          "/workspace/.biodome-build/targets/test-target/startup.sh",
          "--job",
          "sh",
          "-c",
          "printf %s '$TOKEN' > 'proof file.txt'",
        ]);
        expect(command[2]).toContain("aws s3 cp '/workspace/proof file.txt'");
        expect(command[2]).toContain("'proof file.txt' --only-show-errors");
        expect(command[2]).not.toContain("printf %s '$TOKEN'");
      } finally {
        delete process.env.TEST_TASK_ROLE_ARN;
      }
    });

    it("rejects unsafe artifact paths before making cloud calls", async () => {
      process.env.TEST_TASK_ROLE_ARN = "arn:aws:iam::123456789012:role/task";
      const ecsSend = vi.fn();
      const cwSend = vi.fn();
      const target: RuntimeTarget = {
        ...sampleTarget,
        options: {
          ...sampleTarget.options,
          taskRoleArn: { env: "TEST_TASK_ROLE_ARN" },
          artifactBucket: "bucket",
        },
      };
      try {
        const driver = createAwsEcsDriver(makeClients({ ecsSend, cwSend }));
        await expect(
          run(
            driver.runJob({
              ...makeInput({ target }),
              command: ["true"],
              artifactPaths: ["../host-secret"],
            }),
          ),
        ).rejects.toThrow(/Invalid artifact path/);
        expect(ecsSend).not.toHaveBeenCalled();
        expect(cwSend).not.toHaveBeenCalled();
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
        expect(ecsSend).toHaveBeenCalledTimes(6);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries transient DescribeTasks errors instead of faking a timeout", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockRejectedValueOnce(new Error("throttled"))
        .mockResolvedValueOnce({
          tasks: [{ lastStatus: "STOPPED", containers: [{ exitCode: 3 }] }],
        })
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      vi.useFakeTimers();
      try {
        const job = run(driver.runJob({ ...makeInput(), command: ["echo", "hello"] }));
        await vi.runAllTimersAsync();
        const result = await job;
        expect(result.exitCode).toBe(3);
        expect(result.timedOut).toBeFalsy();
        expect(ecsSend).toHaveBeenCalledTimes(6);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails with a typed error after repeated DescribeTasks failures", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockRejectedValue(new Error("api down"));
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      vi.useFakeTimers();
      try {
        const result = run(driver.runJob({ ...makeInput(), command: ["echo", "hello"] }));
        const assertion = expect(result).rejects.toThrow(
          /Failed to poll ECS job task.*DescribeTasks errors.*api down/s,
        );
        await vi.runAllTimersAsync();
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries an eventually-consistent MISSING response for a new job task", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockResolvedValueOnce({
          tasks: [],
          failures: [{ arn: "task", reason: "MISSING" }],
        })
        .mockResolvedValueOnce({
          tasks: [{ lastStatus: "STOPPED", containers: [{ name: "dev", exitCode: 0 }] }],
        })
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      vi.useFakeTimers();
      try {
        const result = run(driver.runJob({ ...makeInput(), command: ["echo", "hello"] }));
        await vi.runAllTimersAsync();
        await expect(result).resolves.toMatchObject({ exitCode: 0 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not report a provider-stopped job without an exit code as success", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({ tasks: [{ taskArn: "arn:aws:ecs:...:task/exec-123" }] })
        .mockResolvedValueOnce({
          tasks: [
            {
              lastStatus: "STOPPED",
              stopCode: "TaskFailedToStart",
              stoppedReason: "CannotPullContainerError",
              containers: [{ name: "dev" }],
            },
          ],
        })
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await expect(
        run(driver.runJob({ ...makeInput(), command: ["echo", "hello"] })),
      ).rejects.toThrow(/TaskFailedToStart.*CannotPullContainerError/s);
    });

    it("reports RunTask placement failures with reason and detail", async () => {
      const ecsSend = vi
        .fn()
        .mockResolvedValueOnce({
          taskDefinition: { taskDefinitionArn: "arn:aws:ecs:...:task-def/exec:1" },
        })
        .mockResolvedValueOnce({
          tasks: [],
          failures: [{ arn: "y", reason: "AgentNotResponding", detail: "agent offline" }],
        })
        .mockResolvedValueOnce({});
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));

      await expect(
        run(driver.runJob({ ...makeInput(), command: ["echo", "hello"] })),
      ).rejects.toThrow(/place the job task.*AgentNotResponding \(agent offline\)/s);
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
        tasks: [{ lastStatus: "RUNNING", healthStatus: "HEALTHY" }],
      });
      const clients = makeClients({ ecsSend });
      const driver = createAwsEcsDriver(clients);
      const result = await run(
        driver.status(makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/abc" }) })),
      );
      expect(result.state).toBe("running");
    });

    it("reports a running but unhealthy task as failed", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({
        tasks: [{ lastStatus: "RUNNING", healthStatus: "UNHEALTHY" }],
      });
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));
      const result = await run(
        driver.status(makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/abc" }) })),
      );
      expect(result).toEqual({ state: "failed", message: "ECS task is running but unhealthy" });
    });

    it("rejects status queries without validated deployment state", async () => {
      const driver = createAwsEcsDriver(makeClients());
      await expect(run(driver.status(makeInput()))).rejects.toThrow(
        /without validated deployment state/,
      );
    });

    it("reports a missing task as stopped, not failed", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({
        tasks: [],
        failures: [{ arn: "task", reason: "MISSING" }],
      });
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));
      const result = await run(
        driver.status(makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/gone" }) })),
      );
      expect(result.state).toBe("stopped");
      expect(result.message).toMatch(/missing/i);
    });

    it("fails with a typed error when the DescribeTasks query fails", async () => {
      const ecsSend = vi.fn().mockRejectedValueOnce(new Error("access denied"));
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));
      await expect(
        run(
          driver.status(makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/abc" }) })),
        ),
      ).rejects.toThrow(/querying ECS task.*access denied/s);
    });

    it("classifies throttling distinctly", async () => {
      const throttled = Object.assign(new Error("rate exceeded"), {
        name: "ThrottlingException",
      });
      const ecsSend = vi.fn().mockRejectedValueOnce(throttled);
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));
      await expect(
        run(
          driver.status(makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/abc" }) })),
        ),
      ).rejects.toThrow(/AWS API throttled while querying ECS task/);
    });

    it("fails with a typed error when the task is absent without MISSING", async () => {
      const ecsSend = vi.fn().mockResolvedValueOnce({ tasks: [], failures: [] });
      const driver = createAwsEcsDriver(makeClients({ ecsSend }));
      await expect(
        run(
          driver.status(makeInput({ state: makeState({ taskArn: "arn:aws:ecs:...:task/abc" }) })),
        ),
      ).rejects.toThrow(/absent without a MISSING failure/);
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
      expect(cwSend.mock.calls[0][0].input).toMatchObject({
        logStreamNamePrefix: "test-deploy-001/dev/",
      });
      expect(cwSend.mock.calls[0][0].input.orderBy).toBeUndefined();
    });

    it("rejects process-scoped ECS logs because supervisor files are not in CloudWatch", async () => {
      const cwSend = vi.fn();
      const plan: Plan = {
        ...samplePlan,
        runtime: {
          ...samplePlan.runtime,
          processes: [
            {
              name: "api",
              command: ["node", "server.js"],
              mode: "daemon",
              bootstrap: false,
              startOn: "start.post",
              environment: {},
              ports: [],
            },
          ],
        },
      };
      const driver = createAwsEcsDriver(makeClients({ cwSend }));

      await expect(
        run(driver.logs({ ...makeInput({ plan }), processName: "api" })),
      ).rejects.toThrow(/cannot filter CloudWatch output.*supervisor files are not exported/s);
      expect(cwSend).not.toHaveBeenCalled();
    });

    it("selects the named job CloudWatch stream", async () => {
      const cwSend = vi.fn().mockResolvedValueOnce({ logStreams: [] });
      const plan: Plan = {
        ...samplePlan,
        deployment: {
          target: sampleTarget,
          deploymentId: "test-deploy-001",
          task: {
            name: "proof-job",
            command: ["true"],
            intent: "Prove job logs",
            input: {},
            artifacts: [],
            timeout: "5m",
            cleanup: "always",
          },
        },
      };
      const driver = createAwsEcsDriver(makeClients({ cwSend }));

      await run(driver.logs({ ...makeInput({ plan }), processName: "proof-job" }));
      expect(cwSend.mock.calls[0][0].input.logStreamNamePrefix).toBe("test-deploy-001-exec/dev/");
    });

    it("propagates CloudWatch API failures instead of reporting empty logs", async () => {
      const cwSend = vi.fn().mockRejectedValueOnce(new Error("AccessDeniedException"));
      const driver = createAwsEcsDriver(makeClients({ cwSend }));

      await expect(run(driver.logs(makeInput()))).rejects.toThrow(
        /listing CloudWatch log streams.*AccessDeniedException/s,
      );
    });

    it("skips log streams without a name", async () => {
      const cwSend = vi
        .fn()
        .mockResolvedValueOnce({
          logStreams: [{}, { logStreamName: "test-deploy-001/stream1" }],
        })
        .mockResolvedValueOnce({ events: [{ timestamp: 1000, message: "hello" }] });
      const driver = createAwsEcsDriver(makeClients({ cwSend }));

      const result = await run(driver.logs(makeInput()));
      expect(result).toBeUndefined();
      expect(cwSend).toHaveBeenCalledTimes(2);
      expect(cwSend.mock.calls[1][0].input.logStreamName).toBe("test-deploy-001/stream1");
    });
  });

  describe("collectArtifacts", () => {
    const artifactTarget = (bucket: string | { env: string }): RuntimeTarget => ({
      ...sampleTarget,
      options: { ...sampleTarget.options, artifactBucket: bucket, artifactPrefix: "my-artifacts" },
    });

    it("returns a failure when artifactBucket is not configured", async () => {
      const driver = createAwsEcsDriver(makeClients());
      await expect(
        run(driver.collectArtifacts({ ...makeInput(), paths: ["/workspace/data"] })),
      ).rejects.toThrow(/does not have artifactBucket configured/);
    });

    it("rejects traversal paths before any S3 call", async () => {
      const s3Send = vi.fn();
      const clients = { ...makeClients(), s3: { send: s3Send } as never };
      const driver = createAwsEcsDriver(clients);

      await expect(
        run(
          driver.collectArtifacts({
            ...makeInput({ target: artifactTarget("bucket") }),
            paths: ["../escape"],
          }),
        ),
      ).rejects.toThrow(/Invalid artifact path "\.\.\/escape"/);
      expect(s3Send).not.toHaveBeenCalled();
    });

    it("downloads declared keys under the deployment prefix", async () => {
      process.env.TEST_ARTIFACT_BUCKET = "my-test-bucket";
      try {
        const s3Send = vi.fn().mockImplementation(() => {
          return Promise.resolve({
            Body: {
              transformToByteArray: () => Promise.resolve(new TextEncoder().encode("test content")),
            },
          });
        });
        const clients = { ...makeClients(), s3: { send: s3Send } as never };
        const driver = createAwsEcsDriver(clients);
        const outputDir = join(tmpdir(), `ecs-artifacts-${randomUUID()}`);
        mkdirSync(outputDir, { recursive: true });
        try {
          const result = await run(
            driver.collectArtifacts({
              ...makeInput({ target: artifactTarget({ env: "TEST_ARTIFACT_BUCKET" }), outputDir }),
              paths: ["summary.md"],
            }),
          );
          expect(result.length).toBe(1);
          expect(s3Send.mock.calls[0][0].input).toMatchObject({
            Bucket: "my-test-bucket",
            Key: "my-artifacts/test-deploy-001/summary.md",
          });
          const written = readFileSync(join(outputDir, "artifacts", "summary.md"), "utf-8");
          expect(written).toBe("test content");
        } finally {
          rmSync(outputDir, { recursive: true, force: true });
        }
      } finally {
        delete process.env.TEST_ARTIFACT_BUCKET;
      }
    });

    it("distinguishes artifacts the task never produced", async () => {
      const missing = Object.assign(new Error("no such key"), { name: "NoSuchKey" });
      const s3Send = vi.fn().mockRejectedValue(missing);
      const clients = { ...makeClients(), s3: { send: s3Send } as never };
      const driver = createAwsEcsDriver(clients);

      await expect(
        run(
          driver.collectArtifacts({
            ...makeInput({ target: artifactTarget("bucket") }),
            paths: ["missing.txt"],
          }),
        ),
      ).rejects.toThrow(/"missing\.txt" was not produced by this task/);
    });

    it("reports IAM failures with actionable guidance", async () => {
      const denied = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      const s3Send = vi.fn().mockRejectedValue(denied);
      const clients = { ...makeClients(), s3: { send: s3Send } as never };
      const driver = createAwsEcsDriver(clients);

      await expect(
        run(
          driver.collectArtifacts({
            ...makeInput({ target: artifactTarget("bucket") }),
            paths: ["out.bin"],
          }),
        ),
      ).rejects.toThrow(/S3 authorization failed.*s3:GetObject.*bucket/s);
    });

    it("enforces the per-artifact byte limit before download", async () => {
      const s3Send = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ContentLength: 256 * 1024 * 1024 + 1,
          Body: {
            transformToByteArray: () => Promise.resolve(new Uint8Array(0)),
          },
        }),
      );
      const clients = { ...makeClients(), s3: { send: s3Send } as never };
      const driver = createAwsEcsDriver(clients);

      await expect(
        run(
          driver.collectArtifacts({
            ...makeInput({ target: artifactTarget("bucket") }),
            paths: ["huge.bin"],
          }),
        ),
      ).rejects.toThrow(/exceeding the .*-byte collection limit/);
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

describe("readArtifactBodyWithinLimit", () => {
  it("stops an async stream as soon as it exceeds the byte cap", async () => {
    let chunksRead = 0;
    const body = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])]) {
          chunksRead += 1;
          yield chunk;
        }
      },
    };

    await expect(readArtifactBodyWithinLimit(body, "large.bin", 3)).rejects.toThrow(
      /large\.bin.*more than 3 bytes/s,
    );
    expect(chunksRead).toBe(2);
  });
});
