import { Schema } from "effect";
import { EnvSpecSchema, type EnvVar, type Plan } from "../plan.js";
import type { EnvSpec } from "../feature.js";
import { ValidationError } from "../errors.js";

const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const safeDefault = /^[^:${}?\x00-\x1f\x7f]+$/; // oxlint-disable-line no-control-regex

export class EnvironmentBuilder {
  constructor(private readonly plan: Plan) {}

  add(key: string, spec: EnvSpec): void {
    if (typeof key !== "string" || !envKeyPattern.test(key)) {
      throw new ValidationError({ message: `Env ${key}: key must match ${envKeyPattern.source}` });
    }
    const env = Schema.decodeSync(EnvSpecSchema)(spec);
    const hasValue = env.value !== undefined;
    if (this.plan.runtime.envVars.some((current) => current.key === key)) {
      throw new ValidationError({ message: `Duplicate env variable: ${key}` });
    }
    if (!hasValue && env.default !== undefined && !safeDefault.test(env.default)) {
      throw new ValidationError({
        message: `Env ${key}: default contains characters that are not safe inside a Docker Compose interpolation default`,
      });
    }
    const scope = env.scope ?? "runtime";
    const normalized: EnvVar = hasValue
      ? { key, scope, value: env.value }
      : { key, scope, from: { env: env.from!.env }, required: env.required, default: env.default };
    this.plan.runtime.envVars.push(normalized);
    if (hasValue && (scope === "build" || scope === "both"))
      this.plan.build.environment[key] = env.value!;
    if (hasValue && (scope === "runtime" || scope === "both"))
      this.plan.runtime.environment[key] = env.value!;
  }
}
