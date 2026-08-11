import { Schema } from "effect";

// Descriptor for an authenticated MCP client. Carries the authorization header
// name, the environment variable that holds the bearer token, and the rendered
// header value template (a reference, never the resolved token). Harness
// generators consume this so header syntax is not duplicated across clients.
export interface McpClientAuth {
  readonly header: string;
  readonly env: string;
  readonly value: string;
}

export const McpClientAuthSchema = Schema.Struct({
  header: Schema.String,
  env: Schema.String,
  value: Schema.String,
});

export function mcpClientAuthFromToken(token: { readonly env: string }): McpClientAuth {
  return {
    header: "Authorization",
    env: token.env,
    value: `Bearer \${${token.env}}`,
  };
}
