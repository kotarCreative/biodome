# API reference

## Programmatic API

The package root intentionally exports only plan-building and validation APIs:

```typescript
import {
  buildPlan,
  buildTargetPlan,
  buildTaskPlan,
  validateConfig,
  validateFeatures,
  validatePlan,
} from "@kotarcreative/biodome";
```

Effect variants (`buildPlanEffect`, `buildTargetPlanEffect`, `buildTaskPlanEffect`,
`validateConfigEffect`, and `validateFeaturesEffect`) are also exported for callers
that compose Biodome work in an Effect application. Type-only exports include the
builder options/configuration, plan, and feature context/specification types.

Feature files are ECMAScript modules. Each file must export a default function that receives the `FeatureContext` for the current project.

```javascript
export default function example(ctx) {
  // contribute to the shared Plan
}
```

## App recipe API

The root runtime export remains intentionally small. App recipe packages import
the separate public subpath:

```typescript
import { app, service, defineAppRecipe } from "@kotarcreative/biodome/app";
```

`defineAppRecipe()` creates a portable recipe factory. `app(name).endpoint()`
and `service(name)` create frozen serializable references; they do not look up a
project while a module is imported. See [Applications and recipes](apps.md) for
implicit app entrypoints and the scoped builder API.

## Context methods

### `addProcess(spec)`

Add a daemon or one-shot process. See [Processes and hooks](processes.md).

### `addHook(spec)`

Add a one-shot process at a lifecycle point.

### `addLanguage(name, options)`

Add a language runtime.

- `name`: `"python"`, `"node"`, `"go"`, `"rust"`, `"java"`
- `options.version`: version string
- `options.packageManager`: for Python `"poetry"`; for Node `"pnpm"`, `"yarn"`, or `"npm"`

When multiple languages are requested, the CLI uses a neutral base image and installs each runtime on top of it.

### `addPackage(manager, name, options)`

Install a package.

- `manager`: `"npm"`, `"pip"`, `"cargo"`, `"go"`, `"gem"`
- `name`: package name
- `options.version`: optional version
- `options.indexUrl`: optional registry/index URL (respected by `npm` and `pip`)

### `addTool(name, options)`

Install a CLI tool or system package. Well-known tools use custom install scripts; unknown names are installed via apt.

- `name`: `"gh"`, `"kubectl"`, `"terraform"`, `"psql"`, `"redis-cli"`, `"docker"`, or any apt package name

### `addService(name, options)`

Add a backing service. See [File layout](file-layout.md).

### `addEndpoint(spec)`

Declare an agent-discoverable endpoint with a name, optional URL/port, credentials (plain or env-referenced), and free-form metadata. Endpoints are surfaced in `biodome info`, `AGENTS.md`, `.biodome-build/plan.json`, and the MCP `get_endpoints` tool. See [Primitives](primitives.md#addendpointspec).

### `addProvider(spec)`

Declare an external provider with a name, type, optional URL/project/mcpUrl, credentials (plain or env-referenced), and free-form metadata. Providers are surfaced in `biodome info`, `AGENTS.md`, `.biodome-build/plan.json`, and the MCP `get_providers` tool. Remote tool discovery requires an `mcpUrl` and a resolvable configured credential. See [Primitives](primitives.md#addproviderspec).

### `addMcpProvider(spec)`

Declare a remote MCP provider. Requires `name`, `type`, `mcpUrl`, and `credentials.token`. The biodome-mcp server connects to the provider's MCP endpoint and exposes all its tools through a code-mode facade (`provider_search`, `provider_describe`, `provider_execute`). See [Primitives](primitives.md#addmcpproviderspec).

### `addJiraProvider(spec)`

Sugar for a Jira MCP provider. Defaults `mcpUrl` to `https://mcp.atlassian.com/v1/mcp/authv2`. Requires `credentials.token`. See [Primitives](primitives.md#addjiraproviderspec).

### `addLinearProvider(spec)`

Sugar for a Linear MCP provider. Defaults `mcpUrl` to `https://mcp.linear.app/mcp`. Accepts `team` (maps to `project`). Requires `credentials.token`. See [Primitives](primitives.md#addlinearproviderspec).

### `addSentryProvider(spec)`

Sugar for a Sentry MCP provider. Defaults `mcpUrl` to `https://mcp.sentry.dev/mcp`. Requires `credentials.token`. See [Primitives](primitives.md#addsentryproviderspec).

### `addSlackProvider(spec)`

Sugar for a Slack MCP provider. `mcpUrl` is required (no stable public default). Requires `credentials.token`. See [Primitives](primitives.md#addslackproviderspec).

### `addGithubProvider(spec)`

Sugar for a GitHub MCP provider. Defaults `mcpUrl` to `https://api.githubcopilot.com/mcp/`. Requires `credentials.token`. See [Primitives](primitives.md#addgithubproviderspec).

### `addEnv(key, spec)`

Declare an environment variable. Provide exactly one of `value` (literal) or `from: { env }` (host passthrough). Optional: `scope` (`"build" | "runtime" | "both"`, default `"runtime"`), and for passthrough vars `required` and `default`. Passthrough values are resolved from the host at `up` time and never written to the image or `plan.json`. See [Primitives](primitives.md#addenvkey-spec).

### `addVolume(spec)`

Mount a local directory or cloud/network storage into Docker-based targets as a live read/write access point, or declare a proxy volume for agent-safe access through the MCP server. AWS ECS does not support mounted volumes. Supported types: `"local"`, `"s3"`, `"gcs"`, `"azure"`, `"sftp"`, `"smb"`, `"webdav"`, `"dropbox"`, `"gdrive"`. Credentials can be literal strings or env references. See [Primitives](primitives.md#addvolumespec).

### `addRepo(spec)`

Declare a Git repository to clone into the sandbox and keep up to date on startup. Supports multiple repos, custom branches/paths, and token or SSH-key authentication via environment references. See [Primitives](primitives.md#addrepospec).

### `addOpencodeHarness(spec)`

Run a headless OpenCode agent inside the sandbox with telemetry capture. See [Primitives](primitives.md#addopencodeharnessspec).

### `addLlmProvider(spec)`

Configure an LLM provider for OpenCode harnesses. See [Primitives](primitives.md#addllmproviderspec).

### `addPiHarness(spec)`

Install and configure the Pi coding agent. See [Primitives](primitives.md#addpiharnessspec).

### `addCodexHarness(spec)`

Run a headless Codex agent inside the sandbox. See [Primitives](primitives.md#addcodexharnessspec).

### `addClaudeHarness(spec)`

Install and configure Claude Code inside the sandbox. See [Primitives](primitives.md#addclaudeharnessspec).

### `addLocalVolume(spec)`

### `addS3Volume(spec)`

### `addGcsVolume(spec)`

### `addAzureVolume(spec)`

### `addSftpVolume(spec)`

### `addSmbVolume(spec)`

### `addWebdavVolume(spec)`

### `addDropboxVolume(spec)`

### `addGdriveVolume(spec)`

Provider-specific wrappers around `addVolume` with friendlier field names. All wrappers accept `proxy`, `readOnly`, and `allowedPaths`. See [Primitives](primitives.md#volume-wrappers).

### MCP volume tools

When proxy volumes are enabled, the MCP server exposes these tools for agent access:

- `list_volumes` — list proxy volumes and their access rules.
- `list_files` — list one bounded page under a volume-qualified path (`s3-data:reports/`). Accepts an optional `limit` (clamped to the configured `maxListEntries`) and opaque `cursor`; returns JSON with `files` and, when more results exist, `nextCursor`.
- `read_file` — read a file as base64 (`s3-data:reports/file.pdf`). Reads larger than configured `maxReadBytes` are rejected without returning partial content.
- `write_file` — write a file from base64 content.
- `stat_file` — get file metadata.

`write_file` validates base64 content before decoding and enforces `maxWriteBytes` against decoded bytes.

### MCP provider tools (code mode)

When providers are declared, the MCP server exposes a progressive-discovery interface instead of per-provider tools. The agent uses these three tools to search, inspect, and call any upstream tool:

- `get_providers` — list declared provider metadata without credentials.
- `provider_search` — search across all connected provider tools by keyword, provider name, or both. Returns tool names formatted as `provider.tool`.
- `provider_describe` — get the full input schema and description for one provider tool (e.g. `linear.create_issue`).
- `provider_execute` — call a tool by its qualified name with arguments. Credentials are attached by the server and never reach the agent.

Only providers with an `mcpUrl` and a resolvable configured credential are connected; skipped providers are reported by discovery. Provider discovery uses bounded parallel requests. Configure `mcp.providerConnectTimeoutMs`,
`mcp.providerRequestTimeoutMs`, and `mcp.providerCatalogConcurrency` to set connection
deadlines, list/describe/call deadlines, and the maximum simultaneous catalog requests.
Defaults are 10 seconds, 30 seconds, and 4. A timed-out provider is reported without
credentials, healthy providers continue, and `provider_execute` is never retried.

### `fileExists(path)`

Check if a file exists relative to the project root.

```javascript
export default function detect(ctx) {
  if (ctx.fileExists("vite.config.ts")) {
    // ...
  }
}
```

### `readFile(path)`

Read a file as a UTF-8 string.

```javascript
export default function readMe(ctx) {
  const content = ctx.readFile("README.md");
}
```

### `readJSON(path)`

Read and parse a JSON file.

```javascript
export default function pkgCheck(ctx) {
  const pkg = ctx.readJSON("package.json");
}
```

### `exec(command)`

Run a shell command on the host during plan generation.

```javascript
export default function branchEnv(ctx) {
  const result = ctx.exec("git branch --show-current");
  console.log(result.stdout);
  console.log(result.stderr);
  console.log(result.exitCode);
}
```

All commands are logged to stdout. Read-only commands (`info`, `config validate`, `generate agents.md`) execute feature modules in dry-run mode, so `ctx.exec` returns empty output and does not shell out.

## Process specification

```typescript
interface ProcessSpec {
  name: string;
  command: string[];
  port?: number;
  ports?: Record<string, number>;
  environment?: Record<string, string>;
  workingDir?: string;
  healthCheck?: {
    type?: "http" | "tcp" | "exec";
    url?: string;
    command?: string[];
    port?: number;
    interval?: string;
    timeout?: string;
    retries?: number;
    startPeriod?: string;
  };
  mode?: "daemon" | "oneshot";
  startOn?: LifecyclePoint;
}
```

## Repo specification

```typescript
interface RepoSpec {
  name: string;
  url: string;
  branch?: string;
  path?: string;
  depth?: number;
  credentials?: {
    token?: { env: string };
    sshKey?: { env: string };
  };
}
```

`credentials.token` is used with HTTPS URLs; `credentials.sshKey` is used with SSH URLs. Both must be environment references (`{ env: "VAR" }`) — literal credential strings are rejected to keep secrets out of `plan.json` and generated scripts.

## Agent harness specification

```typescript
interface AgentHarnessSpec {
  name: string;
  port?: number;
  mcpServers?: Record<string, { url: string }>;
  telemetry?: {
    enabled?: boolean;
    path?: string;
    capturePayloads?: boolean;
  };
  config?: Record<string, unknown>;
}
```

## LLM provider specification

```typescript
interface LlmProviderSpec {
  name: string;
  npm?: string;
  displayName?: string;
  options?: Record<string, string | number | boolean | { env: string }>;
  models?: Record<string, { name?: string }>;
}
```

Credential-like option keys (e.g. `apiKey`) must be environment references (`{ env: "VAR" }`), not literal strings.

## Pi harness specification

```typescript
interface PiHarnessSpec {
  name: string;
  provider?: string;
  model?: string;
  apiKey?: { env: string };
  tools?: string[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  packages?: string[];
  telemetry?: {
    enabled?: boolean;
    path?: string;
    capturePayloads?: boolean;
  };
  config?: Record<string, unknown>;
}
```

## Codex harness specification

```typescript
interface CodexHarnessSpec {
  name: string;
  port?: number;
  model?: string;
  apiKey?: { env: string };
  mcpServers?: Record<string, { url: string }>;
  telemetry?: {
    enabled?: boolean;
    path?: string;
    capturePayloads?: boolean;
  };
  config?: Record<string, unknown>;
}
```

## Claude harness specification

```typescript
interface ClaudeHarnessSpec {
  name: string;
  model?: string;
  apiKey?: { env: string };
  tools?: string[];
  permissions?: string;
  telemetry?: {
    enabled?: boolean;
    path?: string;
    capturePayloads?: boolean;
  };
  config?: Record<string, unknown>;
}
```

## Lifecycle points

```typescript
type LifecyclePoint =
  | "build.pre"
  | "build.post"
  | "start.pre"
  | "start.post"
  | "stop.pre"
  | "stop.post"
  | "exec.pre"
  | "exec.post";
```

## CLI commands

### `biodome init [--bare]`

Create a `.biodome/` directory with a starter config and a generated `.biodome/features/auto-detect.mjs` feature. The auto-detect feature inspects project files (`package.json`, `bun.lockb`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`, etc.) and calls `ctx.addLanguage` for each detected language. Pass `--bare` to skip auto-detection and create a minimal scaffold.

### `biodome build <target>`

Render and build the selected target. Docker Compose targets generate their Dockerfile, Compose file, supervisor configuration, and health checks under `.biodome-build/targets/<target>/`; other runtimes render and build their provider-specific resources.

### `biodome up <target> [--build] [--wait]`

Start the selected target sandbox. Use `--build` to render and build it first. Use `--wait` to keep the CLI alive until Ctrl+C, then stop targets that support stopping.

### `biodome down <target>`

Stop the selected target sandbox. The command requires existing deployment state for that target.

### `biodome exec <target> <command...>`

Run a command in the selected target sandbox.

```bash
biodome exec local npm test
```

### `biodome info`

Print a summary of the project: base image, languages, services, endpoints, providers, environment, connection strings, processes, and hooks.

### `biodome config validate`

Validate the `.biodome/` configuration and feature modules without building. This checks the config schema, validates feature/service module exports, builds the plan in dry-run mode, and runs `validatePlan` to catch port conflicts and other plan-level errors.

### `biodome generate agents.md`

Generate an `AGENTS.md` file with base image, languages, services, endpoints, providers, environment, connection info, processes, and available commands for AI coding agents.

### `biodome logs <target> [process]`

Show logs from a managed process when the target supports log access. Docker-based targets can use `supervisord` logs; other providers may return bounded provider logs instead.

### `biodome ps <target>`

Show the selected target's provider status.

### `biodome status <target>`

Report the selected target's health and, where supported, managed-process status. Docker-based targets use provider status plus `supervisorctl`; providers without process-status support report only target health.

### `biodome restart <target> [process]`

Restart a managed process or all daemon processes when the target supports process control. Restarting all daemons reports unsupported processes as skipped.
