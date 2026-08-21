function isSecretReference(value: unknown): value is { readonly env: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "env" in value &&
    typeof (value as Record<string, unknown>).env === "string"
  );
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
    lower.includes("credential") ||
    lower.includes("private_key") ||
    lower.includes("privatekey") ||
    lower.includes("access_key") ||
    lower.includes("accesskey") ||
    lower.startsWith("auth")
  );
}

// Redact credential-bearing query parameters (?token=, ?sig=, ?api_key=, ...).
// Shared with upstream error redaction so both layers stay aligned.
export function redactQueryTokens(value: string, marker = "***REDACTED***"): string {
  return value.replace(/([?&](?:access_token|api[_-]?key|sig|token)=)[^&#\s]+/gi, `$1${marker}`);
}

// Redact likely embedded credentials from a string. This is a last-resort guard.
export function redactString(value: string): string {
  // https://user:pass@host
  let redacted = value.replace(/(\/\/)[^@\s]+@/g, "$1***REDACTED***@");
  // Bearer / Basic tokens
  redacted = redacted.replace(/\b(Bearer\s+)\S+/gi, "$1***REDACTED***");
  redacted = redacted.replace(/\b(Basic\s+)\S+/gi, "$1***REDACTED***");
  return redactQueryTokens(redacted);
}
