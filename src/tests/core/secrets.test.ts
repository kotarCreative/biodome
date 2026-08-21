import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  isSecretArnReference,
  redactQueryTokens,
  redactSecrets,
  redactString,
  SecretArnReferenceSchema,
  SecretReferenceSchema,
  secretEnv,
  secretShellExpansion,
} from "../../core/secrets.js";

describe("SecretArnReferenceSchema", () => {
  const validArns = [
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/api-token-AbCdEf",
    "arn:aws:ssm:eu-west-1:123456789012:parameter/biodome/pg-password",
    "arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:gov-secret",
  ];
  const invalidArns = [
    "arn:aws:s3:::my-bucket",
    "arn:aws:secretsmanager:bad region:123456789012:secret:x",
    "api-token",
    "https://secretsmanager.aws/secret",
    "",
    "arn:aws:ssm:us-east-1:notanaccount:parameter/x",
  ];

  it("accepts Secrets Manager and SSM parameter ARNs", () => {
    for (const secretArn of validArns) {
      expect(Schema.decodeUnknownSync(SecretArnReferenceSchema)({ secretArn })).toEqual({
        secretArn,
      });
      expect(isSecretArnReference({ secretArn })).toBe(true);
    }
  });

  it("rejects non-AWS or malformed references", () => {
    for (const secretArn of invalidArns) {
      expect(() => Schema.decodeUnknownSync(SecretArnReferenceSchema)({ secretArn })).toThrow();
    }
    expect(isSecretArnReference("api-token")).toBe(false);
    expect(isSecretArnReference({ env: "API_TOKEN" })).toBe(false);
    expect(isSecretArnReference(undefined)).toBe(false);
  });
});

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

  it("redacts private key, access key, and auth-prefixed keys", () => {
    expect(
      redactSecrets({
        private_key: "-----BEGIN RSA PRIVATE KEY-----",
        privateKeyPath: "/tmp/key.pem",
        accessKeyId: "AKIA1234",
        secretAccessKey: "wJalrXU",
        authHeader: "Bearer tok",
      }),
    ).toEqual({
      private_key: "***REDACTED***",
      privateKeyPath: "***REDACTED***",
      accessKeyId: "***REDACTED***",
      secretAccessKey: "***REDACTED***",
      authHeader: "***REDACTED***",
    });
  });

  it("preserves secret references as references", () => {
    expect(redactSecrets({ token: { env: "TOKEN" } })).toEqual({ token: { env: "TOKEN" } });
  });
});

describe("redactString and redactQueryTokens", () => {
  it("redacts credential-bearing query parameters", () => {
    expect(redactString("https://example.com/cb?token=abc&x=1")).toBe(
      "https://example.com/cb?token=***REDACTED***&x=1",
    );
    expect(redactQueryTokens("https://example.com/cb?sig=deadbeef")).toBe(
      "https://example.com/cb?sig=***REDACTED***",
    );
    expect(redactQueryTokens("https://example.com/?api_key=k&access_token=t")).toBe(
      "https://example.com/?api_key=***REDACTED***&access_token=***REDACTED***",
    );
  });

  it("supports an alternate marker for error redaction", () => {
    expect(redactQueryTokens("http://h/path?token=abc", "[REDACTED]")).toBe(
      "http://h/path?token=[REDACTED]",
    );
  });

  it("leaves ordinary query parameters untouched", () => {
    expect(redactQueryTokens("https://example.com/?page=2&q=token%3Dx")).toBe(
      "https://example.com/?page=2&q=token%3Dx",
    );
  });
});
