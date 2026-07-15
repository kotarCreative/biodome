import { Schema } from "effect"

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
}) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  message: Schema.String,
  field: Schema.optionalKey(Schema.String),
}) {}

export class FeatureError extends Schema.TaggedErrorClass<FeatureError>()("FeatureError", {
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
}) {}

export class DockerError extends Schema.TaggedErrorClass<DockerError>()("DockerError", {
  message: Schema.String,
  command: Schema.optionalKey(Schema.String),
}) {}

export class PlanError extends Schema.TaggedErrorClass<PlanError>()("PlanError", {
  message: Schema.String,
}) {}

export type SandboxError = ConfigError | ValidationError | FeatureError | DockerError | PlanError

export function isSandboxError(error: unknown): error is SandboxError {
  return (
    error instanceof ConfigError ||
    error instanceof ValidationError ||
    error instanceof FeatureError ||
    error instanceof DockerError ||
    error instanceof PlanError
  )
}

export function sandboxErrorMessage(error: SandboxError): string {
  switch (error._tag) {
    case "ConfigError":
      return error.path ? `${error.path}: ${error.message}` : error.message
    case "ValidationError":
      return error.field ? `${error.field}: ${error.message}` : error.message
    case "FeatureError":
      return error.path ? `Failed to load feature ${error.path}: ${error.message}` : error.message
    case "DockerError":
      return error.command
        ? `Docker command failed (${error.command}): ${error.message}`
        : error.message
    case "PlanError":
      return error.message
  }
}
