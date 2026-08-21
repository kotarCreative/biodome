import { Schema } from "effect";
import { EnvSpecSchema, type EnvVar, type Plan } from "../plan.js";
import type { EnvSpec } from "../feature.js";
import { ValidationError } from "../errors.js";
import { isSecretArnReference, type SecretArnReference, type SecretReference } from "../secrets.js";
import { assertNoControlChars } from "../validation.js";

const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const safeDefault = /^[^:${}?\x00-\x1f\x7f]+$/; // oxlint-disable-line no-control-regex

function sameEnvVar(a: EnvVar, b: EnvVar): boolean {
  if (a.key !== b.key || a.scope !== b.scope) return false;
  if (a.value !== undefined || b.value !== undefined) return a.value === b.value;
  if (!sameFrom(a.from, b.from)) return false;
  return a.required === b.required && a.default === b.default;
}

function sameFrom(
  a: SecretReference | SecretArnReference | undefined,
  b: SecretReference | SecretArnReference | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if ("env" in a && "env" in b) return a.env === b.env;
  if ("secretArn" in a && "secretArn" in b) return a.secretArn === b.secretArn;
  return false;
}

export class EnvironmentBuilder {
  constructor(private readonly plan: Plan) {}

  /** Whether any declaration (literal or reference) exists for this key. */
  has(key: string): boolean {
    return this.plan.runtime.envVars.some((envVar) => envVar.key === key);
  }

  add(key: string, spec: EnvSpec): void {
    if (typeof key !== "string" || !envKeyPattern.test(key)) {
      throw new ValidationError({ message: `Env ${key}: key must match ${envKeyPattern.source}` });
    }
    const env = Schema.decodeSync(EnvSpecSchema)(spec);
    const hasValue = env.value !== undefined;
    if (hasValue) {
      // Literal values render verbatim in the Dockerfile ENV block; newlines
      // would inject additional instructions.
      assertNoControlChars(env.value, `Env ${key} value`);
    }
    if (!hasValue && env.default !== undefined && !safeDefault.test(env.default)) {
      throw new ValidationError({
        message: `Env ${key}: default contains characters that are not safe inside a Docker Compose interpolation default`,
      });
    }
    const scope = env.scope ?? "runtime";
    // AWS secret ARN references are normalized verbatim; the plan carries the
    // ARN (an identifier, not a secret) and drivers decide how to inject it.
    const from =
      hasValue || env.from === undefined
        ? undefined
        : isSecretArnReference(env.from)
          ? { secretArn: env.from.secretArn }
          : { env: env.from.env };
    const normalized: EnvVar = hasValue
      ? { key, scope, value: env.value }
      : { key, scope, from, required: env.required, default: env.default };
    const existing = this.plan.runtime.envVars.find((current) => current.key === key);
    if (existing) {
      if (sameEnvVar(existing, normalized)) return;
      throw new ValidationError({
        message: `Duplicate env variable with conflicting declarations: ${key}`,
      });
    }
    this.plan.runtime.envVars.push(normalized);
    if (hasValue && (scope === "build" || scope === "both"))
      this.plan.build.environment[key] = env.value!;
    if (hasValue && (scope === "runtime" || scope === "both"))
      this.plan.runtime.environment[key] = env.value!;
  }
}
