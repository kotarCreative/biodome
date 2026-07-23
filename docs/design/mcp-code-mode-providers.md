# Implementation Plan: Remote MCP Providers + Code Mode

Status: completed. All 10 tasks have been implemented — `UpstreamRegistry`, code-mode facade, sugar helpers, plan.json serialization, tests, and docs. Hand-rolled Jira/Linear REST tools have been removed.

## Goal

Turn `biodome-mcp` into an aggregator that connects out to **remote** provider
MCP servers (Jira, Linear, Sentry, Slack, GitHub, ...) and exposes them to the
agent through a **code-mode** facade of three tools — `provider_search`,
`provider_describe`, `provider_execute` — instead of hundreds of individual
tools. Credentials stay in the `biodome-mcp` process only and never reach the
agent.

## Scope decisions (already made — do not revisit)

- **Remote transport only.** Connect to vendor MCP HTTP endpoints with a bearer
  token. No stdio, no sidecar containers, no OAuth flow.
- **Remove the hand-rolled Jira/Linear REST/GraphQL tools entirely.** They are
  replaced by aggregation.
- **Code mode = search / describe / execute** (progressive tool discovery).
  There is NO in-container JavaScript execution sandbox. `provider_execute`
  calls exactly one upstream tool by name. (Arbitrary code composition is a
  possible future enhancement and is out of scope here.)
- Keep it light: no new npm dependencies. The bundled
  `@modelcontextprotocol/sdk` already provides the MCP client.

## Key facts about the codebase (verified)

- `@modelcontextprotocol/sdk` client imports (already installed):
  - `import { Client } from "@modelcontextprotocol/sdk/client/index.js"`
  - `import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"`
- Provider model: `Provider` in `src/core/plan.ts` (~line 91):
  `{ name, type, url?, project?, credentials?, metadata? }`.
- `configureMcp(port)` in `src/core/context.ts` (~lines 982-1019) collects proxy
  **volume** credential env refs into the MCP process env with `mergeEnv:false`.
  This is the credential boundary. We extend it to also collect **provider**
  credential env refs.
- `generatePlanJson` in `src/mcp/generator.ts` (~lines 75-82) serializes provider
  records into `plan.json`; `{ env: "VAR" }` refs are preserved (never resolved).
- `biodome-mcp` runs as a supervisord daemon inside the dev container; its port
  is published on `127.0.0.1` only (`src/docker/generator.ts` ~lines 396-399).
- Provider tools are currently filtered by `filterProviderTools` in
  `src/mcp/provider-tools.ts`, tested in `src/tests/mcp/provider-tools.test.ts`.
- MCP server tool wiring lives in `src/mcp/server.ts`:
  - `providers` loaded at ~line 157; `resolveProvider`/`resolveSecret` ~92-177.
  - Jira helpers ~186-279; Linear helpers ~281-315.
  - `ListTools` handler ~355-719; `CallTool` handler ~722 onward.
  - Provider tool cases: `get_providers` ~747, `jira_*` ~759-895, `linear_*`
    ~897-996.

---

## Task 1 — Extend the provider model with connection fields

File: `src/core/plan.ts`

1. Update the `Provider` interface (~line 91) to add remote-MCP connection
   fields. Final shape:

   ```ts
   export interface Provider {
     name: string;
     type: string;
     // Remote MCP endpoint the biodome-mcp aggregator connects to.
     mcpUrl?: string;
     // Header name used to send the credential (default "Authorization").
     authHeader?: string;
     // Prefix prepended to the credential when sending (e.g. "Bearer ").
     authScheme?: string;
     // Which key in `credentials` holds the token to send. Default "token".
     authCredential?: string;
     url?: string;
     project?: string;
     credentials?: Record<string, SecretValue>;
     metadata?: Record<string, string>;
   }
   ```

2. Find `ProviderSpecSchema` (search for `ProviderSpecSchema = Schema.Struct`).
   Add the new optional string fields so specs validate:
   `mcpUrl`, `authHeader`, `authScheme`, `authCredential` — all
   `Schema.optional(Schema.String)`.

3. Find `ProviderSchema` used inside `PlanSchema` (search `ProviderSchema =` and
   the `providers:` line inside `PlanSchema`). Add the same four optional string
   fields there so `plan.json` round-trips.

Verify:

```bash
npm run typecheck
```

---

## Task 2 — Replace provider helper spec types and add generic + sugar helpers

File: `src/core/feature.ts`

1. Keep `export type ProviderSpec = typeof ProviderSpecSchema.Type`.

2. Replace `JiraProviderSpec` and `LinearProviderSpec` interfaces with a single
   generic remote-MCP spec plus small sugar specs. Add:

   ```ts
   // A remote MCP provider: biodome-mcp connects to `mcpUrl` and forwards the
   // agent's tool calls, attaching the credential server-side.
   export interface McpProviderSpec {
     name: string;
     type: string;
     mcpUrl: string;
     credentials: { token: SecretValue };
     authHeader?: string; // default "Authorization"
     authScheme?: string; // default "Bearer "
     project?: string;
     metadata?: Record<string, string>;
   }

   export interface JiraProviderSpec {
     name: string;
     mcpUrl?: string; // default "https://mcp.atlassian.com/v1/mcp/authv2"
     project?: string;
     credentials: { token: SecretValue };
     metadata?: Record<string, string>;
   }

   export interface LinearProviderSpec {
     name: string;
     mcpUrl?: string; // default "https://mcp.linear.app/mcp"
     team?: string;
     credentials: { token: SecretValue };
     metadata?: Record<string, string>;
   }

   export interface SentryProviderSpec {
     name: string;
     mcpUrl?: string; // default "https://mcp.sentry.dev/mcp"
     credentials: { token: SecretValue };
     metadata?: Record<string, string>;
   }

   export interface SlackProviderSpec {
     name: string;
     mcpUrl: string; // no stable public default; required
     credentials: { token: SecretValue };
     metadata?: Record<string, string>;
   }

   export interface GithubProviderSpec {
     name: string;
     mcpUrl?: string; // default "https://api.githubcopilot.com/mcp/"
     credentials: { token: SecretValue };
     metadata?: Record<string, string>;
   }
   ```

3. In the `FeatureContext` interface, remove the old
   `addJiraProvider`/`addLinearProvider` lines only if present, then declare:

   ```ts
   addProvider(spec: ProviderSpec): void
   addMcpProvider(spec: McpProviderSpec): void
   addJiraProvider(spec: JiraProviderSpec): void
   addLinearProvider(spec: LinearProviderSpec): void
   addSentryProvider(spec: SentryProviderSpec): void
   addSlackProvider(spec: SlackProviderSpec): void
   addGithubProvider(spec: GithubProviderSpec): void
   ```

Verify:

```bash
npm run typecheck   # will fail until Task 3 implements the methods — that is expected
```

---

## Task 3 — Implement the provider methods in the context

File: `src/core/context.ts`

1. Update the import from `./feature.js` to include the new spec types:
   `McpProviderSpec, JiraProviderSpec, LinearProviderSpec, SentryProviderSpec,
SlackProviderSpec, GithubProviderSpec` (remove any that no longer exist).

2. Keep `addProvider(spec)` as-is (it validates via `ProviderSpecSchema`, checks
   duplicate name, pushes onto `plan.runtime.providers`). Ensure it copies the
   new fields through: when building the pushed object include `mcpUrl`,
   `authHeader`, `authScheme`, `authCredential`.

3. Replace the body of `addMcpProvider` (new) and the existing
   `addJiraProvider`/`addLinearProvider` with implementations that delegate to
   `addProvider`. Add the three new sugar methods. Pattern:

   ```ts
   addMcpProvider(spec: McpProviderSpec): void {
     if (!spec.name) throw new ValidationError({ message: "MCP provider requires a name" })
     if (!spec.mcpUrl) throw new ValidationError({ message: `Provider ${spec.name}: mcpUrl is required` })
     if (!spec.credentials?.token) {
       throw new ValidationError({ message: `Provider ${spec.name}: credentials.token is required` })
     }
     this.addProvider({
       name: spec.name,
       type: spec.type,
       mcpUrl: spec.mcpUrl,
       authHeader: spec.authHeader ?? "Authorization",
       authScheme: spec.authScheme ?? "Bearer ",
       authCredential: "token",
       project: spec.project,
       credentials: { token: spec.credentials.token },
       metadata: spec.metadata,
     })
   }

   addJiraProvider(spec: JiraProviderSpec): void {
     this.addMcpProvider({
       name: spec.name,
       type: "jira",
       mcpUrl: spec.mcpUrl ?? "https://mcp.atlassian.com/v1/mcp/authv2",
       project: spec.project,
       credentials: spec.credentials,
       metadata: spec.metadata,
     })
   }

   addLinearProvider(spec: LinearProviderSpec): void {
     this.addMcpProvider({
       name: spec.name,
       type: "linear",
       mcpUrl: spec.mcpUrl ?? "https://mcp.linear.app/mcp",
       project: spec.team,
       credentials: spec.credentials,
       metadata: spec.metadata,
     })
   }

   addSentryProvider(spec: SentryProviderSpec): void {
     this.addMcpProvider({
       name: spec.name, type: "sentry",
       mcpUrl: spec.mcpUrl ?? "https://mcp.sentry.dev/mcp",
       credentials: spec.credentials, metadata: spec.metadata,
     })
   }

   addSlackProvider(spec: SlackProviderSpec): void {
     this.addMcpProvider({
       name: spec.name, type: "slack",
       mcpUrl: spec.mcpUrl,
       credentials: spec.credentials, metadata: spec.metadata,
     })
   }

   addGithubProvider(spec: GithubProviderSpec): void {
     this.addMcpProvider({
       name: spec.name, type: "github",
       mcpUrl: spec.mcpUrl ?? "https://api.githubcopilot.com/mcp/",
       credentials: spec.credentials, metadata: spec.metadata,
     })
   }
   ```

4. Extend `configureMcp` credential collection. Find the loop over
   `plan.runtime.volumes` that builds `mcpEnvironment` (~lines 996-1004). AFTER
   that loop, add a loop over providers:

   ```ts
   for (const provider of this.plan.runtime.providers) {
     if (!provider.credentials) continue;
     for (const value of Object.values(provider.credentials)) {
       if (typeof value === "string") continue;
       mcpEnvironment[value.env] = `\${${value.env}}`;
     }
   }
   ```

Verify:

```bash
npm run typecheck
```

---

## Task 4 — Serialize the new provider fields into plan.json

File: `src/mcp/generator.ts`

Find the `providers:` mapping in `generatePlanJson` (~lines 75-82). Add the new
fields to each serialized record:

```ts
providers: plan.runtime.providers.map((provider) => ({
  name: provider.name,
  type: provider.type,
  mcpUrl: provider.mcpUrl ?? null,
  authHeader: provider.authHeader ?? null,
  authScheme: provider.authScheme ?? null,
  authCredential: provider.authCredential ?? null,
  url: provider.url ?? null,
  project: provider.project ?? null,
  credentials: provider.credentials ?? null,
  metadata: provider.metadata ?? null,
})),
```

Verify:

```bash
npm run typecheck && npm run test:run
```

(Existing `generator.test.ts` provider tests may need the new fields; update
their expected objects in Task 8.)

---

## Task 5 — Build the upstream MCP client module

New file: `src/mcp/upstream.ts`

This module connects to remote provider MCP servers and caches their tool lists.
It has no dependency on the running server; it is unit-testable.

Define and export:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface UpstreamProvider {
  name: string;
  type: string;
  mcpUrl: string;
  authHeader: string; // e.g. "Authorization"
  authScheme: string; // e.g. "Bearer "
  token: string; // already resolved from env by the caller
}

export interface CatalogEntry {
  provider: string; // provider.name
  tool: string; // upstream tool name
  qualified: string; // `${provider}.${tool}` — what the agent references
  description: string;
  inputSchema: unknown;
}

export class UpstreamRegistry {
  // Map qualified name -> { provider, tool }
  // Lazily connect per provider; cache Client + tool list.
  constructor(providers: UpstreamProvider[]);
  async listCatalog(): Promise<CatalogEntry[]>; // connect all, gather tools
  async describe(qualified: string): Promise<CatalogEntry>;
  async call(qualified: string, args: unknown): Promise<unknown>;
  async close(): Promise<void>;
}
```

Implementation notes for the executor:

- For each provider, create a `Client({ name: "biodome-mcp", version: "1.0.0" }, { capabilities: {} })`.
- Build the transport with the auth header injected via `requestInit`:
  ```ts
  new StreamableHTTPClientTransport(new URL(p.mcpUrl), {
    requestInit: { headers: { [p.authHeader]: `${p.authScheme}${p.token}` } },
  });
  ```
- Connect lazily: keep a `Map<string, Client>` and a `Map<string, boolean>` for
  connected state; a private `async ensureConnected(providerName)` that connects
  once. Wrap connect in try/catch and throw a clear `Error` including the
  provider name on failure.
- `listCatalog()`: for each provider, `ensureConnected`, then
  `client.listTools()`; flatten into `CatalogEntry[]` with
  `qualified = \`${provider}.${tool}\``. Cache the result per provider so repeat
calls do not re-list. If a provider fails to connect, skip it and record the
error (do not throw the whole catalog away); expose failures via a
`getErrors(): { provider: string; error: string }[]` method.
- `describe(qualified)`: split on the FIRST `.` into `provider` + `tool`; find
  the entry in the cached catalog; if not cached, list that provider first.
- `call(qualified, args)`: split, `ensureConnected`, then
  `client.callTool({ name: tool, arguments: args })`; return the result.
- `close()`: close all connected clients (best-effort try/catch each).
- Add a helper `parseQualified(qualified: string): { provider: string; tool: string }`
  and export it for tests. Rule: split on the first `.`; error if there is no `.`.

Verify:

```bash
npm run typecheck
```

---

## Task 6 — Rewrite the code-mode facade in the MCP server

File: `src/mcp/server.ts`

### 6a. Remove the hand-rolled provider logic

Delete these (verify exact ranges by searching for the function/case names):

- Jira helpers: `jiraBaseUrl`, `jiraAuthHeaders`, `jiraRequest`,
  `jiraAttachmentHeaders`, `buildMultipartBody`, `jiraAttachmentRequest`
  (~lines 186-279).
- Linear helper: `linearRequest` (~lines 281-315).
- All `jira_*` and `linear_*` tool definitions in the `ListTools` `allTools`
  array.
- All `jira_*` and `linear_*` cases in the `CallTool` switch.
- Keep `providers`, `findProvider`, `resolveProvider`, `resolveSecret`,
  `redactProviderForLog`, and the `get_providers` tool/case — they are reused.

### 6b. Resolve providers into upstream connections

After `const providers = plan.providers || []` (~line 157), build the registry:

```ts
import { UpstreamRegistry, UpstreamProvider } from "./upstream.js";

function toUpstream(p: any): UpstreamProvider | null {
  if (!p.mcpUrl) return null;
  const credKey = p.authCredential || "token";
  const token = resolveSecret(p.credentials?.[credKey]);
  if (!token) return null;
  return {
    name: p.name,
    type: p.type,
    mcpUrl: p.mcpUrl,
    authHeader: p.authHeader || "Authorization",
    authScheme: p.authScheme || "Bearer ",
    token,
  };
}

const upstreamProviders = providers
  .map(toUpstream)
  .filter((x): x is UpstreamProvider => x !== null);
const registry = new UpstreamRegistry(upstreamProviders);
```

### 6c. Add the three code-mode tools to `ListTools`

Add these to the `allTools` array (keep `get_sandbox_info`, `get_endpoints`,
`get_providers`, process/volume tools). Only advertise them when there is at
least one provider (reuse the filter approach — see Task 7):

```ts
{
  name: "provider_search",
  description:
    "Search across all connected provider tools (Jira, Linear, Sentry, ...). " +
    "Returns matching tool names (formatted 'provider.tool'), descriptions, and their provider. " +
    "Use this first to discover which tool to call, then provider_describe for its input schema.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to match against tool names and descriptions." },
      provider: { type: "string", description: "Optional: restrict to one provider by name." },
      limit: { type: "number", description: "Max results (default 20)." },
    },
  },
},
{
  name: "provider_describe",
  description:
    "Get the full input schema and description for one provider tool. " +
    "Pass the qualified name from provider_search, e.g. 'linear.create_issue'.",
  inputSchema: {
    type: "object",
    properties: { tool: { type: "string", description: "Qualified tool name 'provider.tool'." } },
    required: ["tool"],
  },
},
{
  name: "provider_execute",
  description:
    "Execute one provider tool by its qualified name with arguments. " +
    "Credentials are attached by the server; you never need a token.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Qualified tool name 'provider.tool'." },
      arguments: { type: "object", description: "Arguments object matching the tool's input schema." },
    },
    required: ["tool"],
  },
},
```

### 6d. Add the three cases to `CallTool`

```ts
case "provider_search": {
  const query = typeof args?.query === "string" ? args.query.toLowerCase() : ""
  const providerFilter = typeof args?.provider === "string" ? args.provider : undefined
  const limit = typeof args?.limit === "number" ? Math.min(Math.max(1, args.limit), 100) : 20
  const catalog = await registry.listCatalog()
  let matches = catalog
  if (providerFilter) matches = matches.filter((e) => e.provider === providerFilter)
  if (query) {
    matches = matches.filter((e) =>
      e.qualified.toLowerCase().includes(query) ||
      (e.description || "").toLowerCase().includes(query)
    )
  }
  const results = matches.slice(0, limit).map((e) => ({
    tool: e.qualified, provider: e.provider, description: e.description,
  }))
  const result = { content: [{ type: "text", text: JSON.stringify({ results, errors: registry.getErrors() }, null, 2) }] }
  logCall(name, args, result)
  return result
}

case "provider_describe": {
  const tool = typeof args?.tool === "string" ? args.tool : ""
  if (!tool) throw new McpError(ErrorCode.InvalidParams, "tool is required")
  const entry = await registry.describe(tool)
  const result = { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] }
  logCall(name, args, result)
  return result
}

case "provider_execute": {
  const tool = typeof args?.tool === "string" ? args.tool : ""
  if (!tool) throw new McpError(ErrorCode.InvalidParams, "tool is required")
  const toolArgs = (args?.arguments && typeof args.arguments === "object") ? args.arguments : {}
  const data = await registry.call(tool, toolArgs)
  const result = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
  logCall(name, args, result)   // args do not contain secrets; safe to log
  return result
}
```

### 6e. Map upstream errors to McpError

In the outer `try/catch` of the `CallTool` handler, the existing
`instanceof McpError` / generic branch is enough. Ensure `registry` errors
surface as `McpError(ErrorCode.InternalError, ...)` (wrap in the default branch).

Verify:

```bash
npm run typecheck
```

---

## Task 7 — Generalize the dynamic tool filter

File: `src/mcp/provider-tools.ts`

Replace the Jira/Linear-specific logic with code-mode logic:

```ts
// Provider tools are only advertised when at least one provider is declared.
const PROVIDER_TOOL_NAMES = new Set([
  "get_providers",
  "provider_search",
  "provider_describe",
  "provider_execute",
]);

export function filterProviderTools(tools: any[], providers: any[]): any[] {
  const hasProviders = providers.length > 0;
  return tools.filter((tool) => {
    if (PROVIDER_TOOL_NAMES.has(tool.name)) return hasProviders;
    return true;
  });
}
```

Verify:

```bash
npm run typecheck
```

---

## Task 8 — Tests

### 8a. Rewrite `src/tests/mcp/provider-tools.test.ts`

Replace Jira/Linear cases with:

- No providers -> none of `get_providers`, `provider_search`,
  `provider_describe`, `provider_execute` present; base tools remain.
- One provider (any type) -> all four provider tools present.

### 8b. New `src/tests/mcp/upstream.test.ts`

Test the pure logic without real network:

- `parseQualified("linear.create_issue")` -> `{ provider: "linear", tool: "create_issue" }`.
- `parseQualified("a.b.c")` -> `{ provider: "a", tool: "b.c" }` (split on first dot).
- `parseQualified("nodot")` throws.
- For `listCatalog`/`describe`/`call`: inject a fake client factory. Refactor
  `UpstreamRegistry` to accept an optional `connect` function in its constructor
  (dependency injection) so tests pass a stub returning a fake client with
  `listTools()` and `callTool()`. Assert catalog qualification, describe lookup,
  call routing, and that a failing provider is captured in `getErrors()` without
  breaking the others.

### 8c. Update `src/tests/mcp/generator.test.ts`

Update the two provider tests to expect the new serialized fields
(`mcpUrl`, `authHeader`, `authScheme`, `authCredential`). Construct providers via
the plan with the new shape.

### 8d. Update `src/tests/core/context.test.ts`

- Replace old `addJiraProvider`/`addLinearProvider` assertions with the new
  shape (they now set `mcpUrl`, `authHeader:"Authorization"`,
  `authScheme:"Bearer "`, `type`).
- Add a test that `addMcpProvider` requires `mcpUrl` and `credentials.token`.
- Add a test that `configureMcp` places a provider's credential env ref into the
  `biodome-mcp` process environment and NOT into `plan.runtime.environment`
  (mirror the existing proxy-volume isolation test).

### 8e. Update `src/tests/core/info.test.ts`

The info/AGENTS.md provider rendering still reads `type`, `url`, `project`,
`credentials`, `metadata`. Providers no longer always have `url` (they have
`mcpUrl`). Update `src/core/info.ts` `formatProvider` to fall back to `mcpUrl`
when `url` is absent, and update the test accordingly.

Verify:

```bash
npm run typecheck && npm run test:run
```

---

## Task 9 — Docs

- `docs/primitives.md`: replace the `addJiraProvider`/`addLinearProvider`
  sections with:
  - `addMcpProvider(spec)` — generic remote MCP provider.
  - Sugar: `addJiraProvider`, `addLinearProvider`, `addSentryProvider`,
    `addSlackProvider`, `addGithubProvider`.
  - A "Code mode" subsection explaining the agent sees only `provider_search`,
    `provider_describe`, `provider_execute`, and that credentials never reach the
    agent (attached server-side by biodome-mcp).
- `docs/api.md`: update the method list and the "MCP provider tools" list to the
  three code-mode tools + `get_providers`. Remove `jira_*` / `linear_*` entries.

Verify: manual read; ensure no references to removed tools remain:

```bash
rg -n "jira_list_issues|jira_get_issue|jira_create_issue|jira_get_attachment|jira_add_attachment|linear_list_issues|linear_get_issue|linear_create_issue|linear_add_attachment" src docs
# expect: no matches
```

---

## Task 10 — Final verification

```bash
npm run typecheck
npm run test:run
```

Both must pass. Do a final grep to confirm the hand-rolled logic is gone:

```bash
rg -n "jiraRequest|linearRequest|jiraAttachmentRequest" src   # expect no matches
```

## Acceptance criteria

- [x] `addMcpProvider` + five sugar helpers exist and delegate to `addProvider`.
- [x] Provider credential env refs land in the `biodome-mcp` process env only
      (`mergeEnv:false`), never in the dev container global env.
- [x] `plan.json` carries `mcpUrl`/`authHeader`/`authScheme`/`authCredential`
      and keeps credentials as `{ env }` refs.
- [x] `biodome-mcp` exposes exactly `provider_search`, `provider_describe`,
      `provider_execute`, and `get_providers` for providers (plus existing
      sandbox/volume tools); no per-provider tools.
- [x] `provider_execute` routes to the correct upstream MCP server, attaches the
      credential server-side, and returns the upstream result.
- [x] A failing upstream provider is reported via `errors` and does not break the
      others.
- [x] All hand-rolled Jira/Linear REST/GraphQL code is deleted.
- [x] `npm run typecheck` and `npm run test:run` pass.

## Notes / gotchas for the executor

- Do not add npm dependencies. Use only `@modelcontextprotocol/sdk` (already
  present) and Node built-ins.
- `resolveSecret` reads `process.env[value.env]`; the env var is present in the
  MCP process because `configureMcp` injected it. Do not resolve secrets at plan
  time or write them to `plan.json`.
- Split qualified tool names on the FIRST `.` only; upstream tool names may
  contain dots but provider names (validated) do not.
- Keep `provider_execute` limited to a single upstream tool call. No JS sandbox,
  no arbitrary code. That is a deliberate scope boundary.
- When connecting upstream, set a connect timeout and surface failures with the
  provider name so misconfiguration is debuggable.
