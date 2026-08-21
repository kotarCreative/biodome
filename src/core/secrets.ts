import { Schema } from "effect";

export { redactQueryTokens, redactSecrets, redactString } from "./redaction.js";

// Valid environment variable name: letter or underscore, followed by letters,
// digits, or underscores.
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A typed reference to a secret stored in an environment variable. This type is
// intentionally not a union with `string`; credential-bearing fields must use it
// so that literal secrets are rejected at schema/decode time rather than
// accidentally persisted in plans, generated files, or events.
export interface SecretReference {
  readonly env: string;
}

// Schema for a secret reference. Literal strings are never accepted.
export const SecretReferenceSchema = Schema.Struct({
  env: Schema.String.check(Schema.isMinLength(1)).check(
    Schema.makeFilter((value) =>
      ENV_VAR_NAME_PATTERN.test(value) ? undefined : "must be a valid environment variable name",
    ),
  ),
});

// A typed reference to an AWS-managed secret: a Secrets Manager secret ARN or
// an SSM Parameter Store parameter ARN (full ARN required, so the region and
// account are explicit). Only sites that explicitly opt in accept this kind;
// targets without native AWS secret injection reject it with guidance.
export interface SecretArnReference {
  readonly secretArn: string;
}

const SECRET_ARN_PATTERN =
  /^arn:(?:aws|aws-cn|aws-us-gov|aws-iso(?:-[a-z]+)?):(secretsmanager|ssm):[a-z0-9-]+:[0-9]{12}:.+$/;

export const SecretArnReferenceSchema = Schema.Struct({
  secretArn: Schema.String.check(Schema.isMinLength(1)).check(
    Schema.makeFilter((value) =>
      SECRET_ARN_PATTERN.test(value)
        ? undefined
        : "must be a Secrets Manager or SSM Parameter Store ARN",
    ),
  ),
});

export function isSecretArnReference(value: unknown): value is SecretArnReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "secretArn" in value &&
    typeof (value as Record<string, unknown>).secretArn === "string"
  );
}

export type SecretReferenceEncoded = typeof SecretReferenceSchema.Encoded;
export type SecretReferenceDecoded = typeof SecretReferenceSchema.Type;

// A non-secret value that may still be supplied through an environment variable.
// Used for non-credential configuration that should remain out of baked plans.
export type EnvReference = string | SecretReference;

export const EnvReferenceSchema = Schema.Union([Schema.String, SecretReferenceSchema]);

export function isSecretReference(value: unknown): value is SecretReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "env" in value &&
    typeof (value as Record<string, unknown>).env === "string"
  );
}

// Return the referenced environment variable name, or undefined if the value is
// not a secret reference.
export function secretEnv(value: SecretReference | undefined): string | undefined {
  return value?.env;
}

// Render a secret reference as a shell variable expansion (e.g. "${VAR}").
export function secretShellExpansion(value: SecretReference): string {
  return `\${${value.env}}`;
}
