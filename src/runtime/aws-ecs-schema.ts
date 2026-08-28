import { Schema } from "effect";
import { RuntimeError } from "../core/errors.js";

/**
 * The one workspace source ECS supports: the repository content is uploaded as
 * part of the immutable image build context and materialized at /workspace.
 * Host bind strategies are impossible on Fargate; clone/snapshot require a
 * cloud-side fetch step that is not designed yet.
 */
export const ECS_WORKSPACE_STRATEGY = "upload";

export interface AwsEcsOptions {
  region: string;
  cluster: string;
  repository: string;
  executionRoleArn: { env: string };
  taskRoleArn?: { env: string };
  subnets: string[];
  securityGroups: string[];
  assignPublicIp?: boolean;
  cpu?: number;
  memoryMiB?: number;
  workspace: { strategy: typeof ECS_WORKSPACE_STRATEGY };
  /**
   * Fargate capacity provider for task placement. EC2 capacity providers are
   * incompatible with this driver's Fargate-only task definitions.
   */
  capacityProvider?: "FARGATE" | "FARGATE_SPOT";
  artifactBucket?: { env: string } | string;
  artifactPrefix?: string;
}

const EnvRefSchema = Schema.Struct({
  env: Schema.String.check(Schema.isMinLength(1)),
});

const WorkspaceSchema = Schema.Struct({
  strategy: Schema.Literals([ECS_WORKSPACE_STRATEGY]),
});

export const AwsEcsOptionsSchema = Schema.Struct({
  region: Schema.String.check(Schema.isMinLength(1)),
  cluster: Schema.String.check(Schema.isMinLength(1)),
  repository: Schema.String.check(Schema.isMinLength(1)),
  executionRoleArn: EnvRefSchema,
  taskRoleArn: Schema.optional(EnvRefSchema),
  subnets: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  securityGroups: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  assignPublicIp: Schema.optional(Schema.Boolean),
  cpu: Schema.optional(Schema.Number),
  memoryMiB: Schema.optional(Schema.Number),
  workspace: WorkspaceSchema,
  capacityProvider: Schema.optional(Schema.Literals(["FARGATE", "FARGATE_SPOT"])),
  artifactBucket: Schema.optional(
    Schema.Union([EnvRefSchema, Schema.String.check(Schema.isMinLength(1))]),
  ),
  artifactPrefix: Schema.optional(Schema.String),
});

const FARGATE_CPU_MEMORY: Record<number, number[]> = {
  256: [512, 1024, 2048],
  512: [1024, 2048, 3072, 4096],
  1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
  2048: rangeByStep(4096, 16384, 1024),
  4096: rangeByStep(8192, 30720, 1024),
  8192: rangeByStep(16384, 61440, 4096),
  16384: rangeByStep(32768, 122880, 8192),
};

function rangeByStep(start: number, end: number, step: number): number[] {
  const result: number[] = [];
  for (let v = start; v <= end; v += step) {
    result.push(v);
  }
  return result;
}

export function validateFargateCpuMemory(cpu: number, memoryMiB: number): void {
  const validMemories = FARGATE_CPU_MEMORY[cpu];
  if (!validMemories) {
    const supported = Object.keys(FARGATE_CPU_MEMORY).map(Number);
    throw new RuntimeError({
      message: `Unsupported Fargate CPU ${cpu}. Supported CPU values: ${supported.join(", ")}`,
    });
  }
  if (!validMemories.includes(memoryMiB)) {
    throw new RuntimeError({
      message: `Unsupported Fargate memory ${memoryMiB} MiB for CPU ${cpu}. Supported values: ${validMemories.join(", ")}`,
    });
  }
}

export const FARGATE_SUPPORTED_CPU = new Set(Object.keys(FARGATE_CPU_MEMORY).map(Number));

export function validateAwsEcsOptions(raw: unknown): AwsEcsOptions {
  // `ttl` was removed as a locked decision: a host-side timer is not a
  // lifecycle guarantee in the cloud, so accepting it silently would promise
  // expiry ECS never performs.
  if (
    raw !== null &&
    typeof raw === "object" &&
    "ttl" in raw &&
    (raw as Record<string, unknown>).ttl !== undefined
  ) {
    throw new RuntimeError({
      message:
        'The aws-ecs target no longer accepts the "ttl" option. Cloud-side task expiry is not implemented; remove ttl and stop tasks explicitly with "biodome down".',
    });
  }

  let decoded: AwsEcsOptions;
  try {
    decoded = Schema.decodeUnknownSync(AwsEcsOptionsSchema)(raw) as AwsEcsOptions;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError({
      message: `Invalid aws-ecs target options: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  if (decoded.subnets.length === 0) {
    throw new RuntimeError({ message: "At least one subnet is required for ECS" });
  }
  if (decoded.subnets.length > 16) {
    throw new RuntimeError({ message: "ECS supports at most 16 subnets per task" });
  }
  if (decoded.securityGroups.length === 0) {
    throw new RuntimeError({ message: "At least one security group is required for ECS" });
  }
  if (decoded.securityGroups.length > 5) {
    throw new RuntimeError({ message: "ECS supports at most 5 security groups per task" });
  }

  const cpu = decoded.cpu ?? 1024;
  const memoryMiB = decoded.memoryMiB ?? 2048;
  validateFargateCpuMemory(cpu, memoryMiB);

  return decoded;
}
