import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  redactSecrets,
  SecretReferenceSchema,
  secretEnv,
  secretShellExpansion,
} from "../../core/secrets.js";

describe("SecretReferenceSchema", () => {
  it("accepts an environment reference", () => {
    const decoded = Schema.decodeUnknownSync(SecretReferenceSchema)({ env: "API_TOKEN" });
    expect(decoded).toEqual({ env: "API_TOKEN" });
  });

  it("rejects literal strings", () => {
    expect(() => Schema.decodeUnknownSync(SecretReferenceSchema)("secret")).toThrow();
  });

  it("rejects empty or invalid environment variable names", () => {
    expect(() => Schema.decodeUnknownSync(SecretReferenceSchema)({ env: "" })).toThrow();
    expect(() => Schema.decodeUnknownSync(SecretReferenceSchema)({ env: "123_BAD" })).toThrow();
  });
});

describe("secret helpers", () => {
  it("returns the referenced environment variable", () => {
    expect(secretEnv({ env: "VAR" })).toBe("VAR");
    expect(secretEnv(undefined)).toBeUndefined();
  });

  it("renders a shell expansion", () => {
    expect(secretShellExpansion({ env: "VAR" })).toBe("${VAR}");
  });
});

describe("redactSecrets", () => {
  it("leaves ordinary values unchanged", () => {
    expect(redactSecrets({ name: "api", port: 8080 })).toEqual({ name: "api", port: 8080 });
  });

  it("replaces URL userinfo with a redaction marker", () => {
    expect(redactSecrets("https://user:pass@example.com/path")).toBe(
      "https://***REDACTED***@example.com/path",
    );
  });

  it("redacts bearer and basic authorization headers", () => {
    expect(redactSecrets("Authorization: Bearer secret-token")).toBe(
      "Authorization: Bearer ***REDACTED***",
    );
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic ***REDACTED***",
    );
  });

  it("redacts credential-looking string values", () => {
    expect(redactSecrets({ apiKey: "secret", password: "hunter2" })).toEqual({
      apiKey: "***REDACTED***",
      password: "***REDACTED***",
    });
  });

  it("preserves secret references as references", () => {
    expect(redactSecrets({ token: { env: "TOKEN" } })).toEqual({ token: { env: "TOKEN" } });
  });
});
