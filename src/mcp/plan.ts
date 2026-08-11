import { Schema } from "effect";
import type { VolumeConfig } from "./volumes/adapter.js";

const SecretSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ env: Schema.String }),
  Schema.Null,
]);
// The MCP bearer token is always an environment reference (never a literal
// value) in generated plans. Literal strings are rejected at decode time.
const McpTokenSchema = Schema.Union([Schema.Struct({ env: Schema.String }), Schema.Null]);
const StringMapSchema = Schema.Record(Schema.String, Schema.String);
const CredentialMapSchema = Schema.Record(Schema.String, SecretSchema);

export const McpPlanSchema = Schema.Struct({
  project: Schema.String,
  languages: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.optional(Schema.String),
      packageManager: Schema.optional(Schema.String),
    }),
  ),
  services: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      image: Schema.String,
      ports: Schema.Array(Schema.Struct({ host: Schema.Number, container: Schema.Number })),
      connection: Schema.optional(Schema.Unknown),
    }),
  ),
  processes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      command: Schema.Array(Schema.String),
      ports: Schema.Array(Schema.Struct({ host: Schema.Number, container: Schema.Number })),
      mode: Schema.String,
      startOn: Schema.String,
    }),
  ),
  endpoints: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      url: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      port: Schema.optional(Schema.Union([Schema.Number, Schema.Null])),
      credentials: Schema.optional(Schema.Unknown),
      metadata: Schema.optional(Schema.Unknown),
    }),
  ),
  providers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      url: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      project: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      mcpUrl: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      authHeader: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      authScheme: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      authCredential: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      credentials: Schema.optional(Schema.Union([CredentialMapSchema, Schema.Null])),
      metadata: Schema.optional(Schema.Unknown),
    }),
  ),
  environment: StringMapSchema,
  envVars: Schema.Array(Schema.Unknown),
  volumes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      target: Schema.String,
      source: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      bucket: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      prefix: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      path: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      endpoint: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      account: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      container: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      host: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      port: Schema.optional(Schema.Union([Schema.Number, Schema.Null])),
      share: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      url: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      vendor: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      credentials: Schema.optional(CredentialMapSchema),
      proxy: Schema.optional(Schema.Boolean),
      readOnly: Schema.optional(Schema.Boolean),
      allowedPaths: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  repos: Schema.Array(Schema.Unknown),
  mcp: Schema.Struct({
    enabled: Schema.optional(Schema.Boolean),
    token: Schema.optional(McpTokenSchema),
    allowExec: Schema.optional(Schema.Boolean),
    allowProcessControl: Schema.optional(Schema.Boolean),
    maxReadBytes: Schema.optional(Schema.Number),
    maxWriteBytes: Schema.optional(Schema.Number),
    maxListEntries: Schema.optional(Schema.Number),
    providerConnectTimeoutMs: Schema.optional(Schema.Number),
    providerRequestTimeoutMs: Schema.optional(Schema.Number),
    providerCatalogConcurrency: Schema.optional(Schema.Number),
  }),
});

export type McpPlan = typeof McpPlanSchema.Type;
export type McpVolume = VolumeConfig;

export function decodeMcpPlan(input: unknown): McpPlan {
  return Schema.decodeUnknownSync(McpPlanSchema)(input);
}

export function resolvePlanSecret(
  value: string | { readonly env: string } | null | undefined,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (typeof value === "string") return value;
  if (value && "env" in value) return environment[value.env] ?? null;
  return null;
}
