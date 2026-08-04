import { Schema } from "effect";
import { RuntimeError } from "../core/errors.js";

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
  ttl?: string;
  artifactBucket?: { env: string } | string;
  artifactPrefix?: string;
}

const EnvRefSchema = Schema.Struct({
  env: Schema.String.check(Schema.isMinLength(1)),
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
  ttl: Schema.optional(Schema.String),
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
  const decoded = Schema.decodeUnknownSync(AwsEcsOptionsSchema)(raw);

  if (decoded.subnets.length === 0) {
    throw new RuntimeError({ message: "At least one subnet is required for ECS" });
  }
  if (decoded.securityGroups.length === 0) {
    throw new RuntimeError({ message: "At least one security group is required for ECS" });
  }

  const cpu = decoded.cpu ?? 1024;
  const memoryMiB = decoded.memoryMiB ?? 2048;
  validateFargateCpuMemory(cpu, memoryMiB);

  return decoded as AwsEcsOptions;
}

export function validateTtl(ttl: string | undefined): number | undefined {
  if (!ttl) return undefined;
  const match = /^(\d+)(s|m|h)$/.exec(ttl);
  if (!match) {
    throw new RuntimeError({
      message: `Invalid ECS TTL "${ttl}". Use positive integer + s/m/h (e.g. "30m", "1h")`,
    });
  }
  const num = parseInt(match[1], 10);
  if (num <= 0) {
    throw new RuntimeError({ message: `ECS TTL must be positive: "${ttl}"` });
  }
  const unit = match[2];
  switch (unit) {
    case "s":
      return num;
    case "m":
      return num * 60;
    case "h":
      return num * 3600;
    default:
      throw new RuntimeError({ message: `Unknown TTL unit: ${unit}` });
  }
}
