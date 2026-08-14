import { Schema } from "effect";

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

// Centralized redaction of known secret shapes. This is defense in depth: the
// primary defense is never putting resolved secrets in events/errors in the
// first place.
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretReference(entry)) {
      result[key] = { env: entry.env };
    } else if (looksLikeCredentialKey(key) && typeof entry === "string") {
      result[key] = "***REDACTED***";
    } else {
      result[key] = redactSecrets(entry);
    }
  }
  return result;
}

// Heuristic for structural redaction: keys that commonly hold credentials.
function looksLikeCredentialKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("password") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("credential")
  );
}

// Redact likely embedded credentials from a string. This is a last-resort guard.
function redactString(value: string): string {
  // https://user:pass@host
  let redacted = value.replace(/(\/\/)[^@\s]+@/g, "$1***REDACTED***@");
  // Bearer / Basic tokens
  redacted = redacted.replace(/\b(Bearer\s+)\S+/gi, "$1***REDACTED***");
  redacted = redacted.replace(/\b(Basic\s+)\S+/gi, "$1***REDACTED***");
  return redacted;
}
