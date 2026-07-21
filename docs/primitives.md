# Primitives

Primitives are the building blocks of a biodome. You add them through the context object passed to your feature modules.

## `addProcess(spec)`

Declares a long-running process managed by `supervisord` inside the dev container. Daemon processes are started automatically when the container starts, expose ports, and can have health checks.

```javascript
export default function django(ctx) {
  ctx.addProcess({
    name: "django",
    command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
    port: 8000,
    healthCheck: {
      type: "http",
      url: "http://localhost:8000/admin/login/",
      interval: "5s",
      timeout: "3s",
      retries: 10,
    },
    environment: { DEBUG: "1" },
  });
}
```

- `name` — unique identifier.
- `command` — array of command arguments.
- `port` — single port to expose (host and container use the same port).
- `ports` — named ports, e.g. `{ app: 8000, debug: 5678 }`.
- `environment` — environment variables for the process.
- `workingDir` — working directory inside the container.
- `healthCheck` — see [health checks](#health-checks).
- `mode` — defaults to `"daemon"`. Set to `"oneshot"` for a one-shot command.
- `startOn` — lifecycle point for one-shot commands. Defaults to `"start.post"`.

## `addHook(spec)`

Sugar for `addProcess({ mode: "oneshot", ... })`. Hooks run once at a specific lifecycle point.

```javascript
export default function migrate(ctx) {
  ctx.addHook({
    name: "migrate",
    command: ["python", "manage.py", "migrate"],
    startOn: "start.post",
  });
}
```

Lifecycle points:

- `build.pre` / `build.post`
- `start.pre` / `start.post`
- `stop.pre` / `stop.post`
- `exec.pre` / `exec.post`

## `addLanguage(name, options)`

Adds a language runtime and configures dependency installation.

```javascript
export default function stack(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addLanguage("node", { version: "20", packageManager: "pnpm" });
  ctx.addLanguage("php", { version: "8.3" });
}
```

Language setup affects:

- The base Docker image.
- Which manifest files are copied.
- How dependencies are installed.
- What artifacts are copied into the final dev stage.

Manifest files are detected from the project root. For example, Node.js uses `npm ci` when `package-lock.json` exists and falls back to `npm install` when only `package.json` exists. PHP projects use `composer install` when `composer.json` is present. If no manifest is present, only the base image is configured and no dependency install step is emitted.

When multiple languages are requested, the CLI uses a neutral base image (`debian:12-slim`) and installs every runtime on top of it, so processes can use any combination of languages in the same container.

## `addPackage(manager, name, options)`

Installs a package through a language-specific package manager.

```javascript
export default function packages(ctx) {
  ctx.addPackage("npm", "typescript", { version: "5.4" });
  ctx.addPackage("pip", "django", { version: "5.0" });
  ctx.addPackage("cargo", "ripgrep");
  ctx.addPackage("go", "github.com/air-verse/air");
}
```

- `options.version` pins a version where the manager supports it.

## `addTool(name, options)`

Installs a CLI tool or system package. Well-known tools use custom install scripts; unknown names are treated as apt packages.

```javascript
export default function tools(ctx) {
  ctx.addTool("gh");
  ctx.addTool("kubectl");
  ctx.addTool("terraform");
  ctx.addTool("psql");
  ctx.addTool("redis-cli");
  ctx.addTool("docker");

  // Unknown names are installed via apt.
  ctx.addTool("curl");
  ctx.addTool("git");
  ctx.addTool("libpq-dev");
}
```

## `addService(name, options)`

Declares a backing service. See [services in file-layout.md](file-layout.md) for details.

```javascript
export default function services(ctx) {
  ctx.addService("postgres", {
    port: 5432,
    databases: [{ name: "myapp" }],
    users: [{ name: "myapp", password: "devpassword" }],
  });
}
```

## `addEndpoint(spec)`

Declares an agent-discoverable endpoint — a custom API or resource a feature stands up — along with how to reach it and any credentials needed to use it. Endpoints appear in `biodome info`, the generated `AGENTS.md`, `.biodome-build/plan.json`, and the MCP `get_endpoints` tool, so an agent can discover the port, URL, credentials, and metadata for a service you created.

```javascript
export default function djangoApi(ctx) {
  ctx.addEndpoint({
    name: "django-api",
    description: "Django REST API",
    url: "http://localhost:8000",
    port: 8000,
    credentials: {
      username: "admin",
      // Env references are resolved from the running container at request time,
      // so the secret is never written into plan.json.
      password: { env: "DJANGO_ADMIN_PASSWORD" },
      token: { env: "DJANGO_API_TOKEN" },
    },
    metadata: { framework: "django", docsPath: "/api/schema" },
  });
}
```

- `name` — unique identifier.
- `description` — optional human-readable summary.
- `url` — optional address the endpoint is reachable at.
- `port` — optional port the endpoint listens on.
- `credentials` — optional map of named credentials. Each value is either a literal string or an `{ env: "VAR_NAME" }` reference.
- `metadata` — optional map of free-form string key/value pairs for anything that doesn't fit the fields above.

### Credentials and secrets

Credential values can be plain strings or environment-variable references:

- **Literal** (`password: "devpassword"`) — stored verbatim. Convenient for throwaway local dev values, but it is written to `.biodome-build/plan.json` and surfaced by every info surface.
- **Env reference** (`password: { env: "DJANGO_ADMIN_PASSWORD" }`) — the secret stays out of `plan.json` and the generated `AGENTS.md` (they show `$DJANGO_ADMIN_PASSWORD`). The MCP `get_endpoints` tool resolves the reference from the container's live environment when an agent asks, so real secrets are never persisted on disk.

Prefer env references for anything sensitive.

## `addProvider(spec)`

Declares an external provider — a well-known SaaS API such as Jira, GitHub, or Slack. Providers are surfaced in `biodome info`, the generated `AGENTS.md`, `.biodome-build/plan.json`, and the MCP `get_providers` tool. When MCP is enabled, the server exposes three code-mode tools — `provider_search`, `provider_describe`, `provider_execute` — that aggregate all provider tools under a single progressive-discovery interface.

```javascript
export default function providers(ctx) {
  ctx.addProvider({
    name: "github",
    type: "github",
    url: "https://api.github.com",
    credentials: {
      token: { env: "GITHUB_TOKEN" },
    },
    metadata: { org: "acme" },
  });
}
```

- `name` — unique identifier.
- `type` — provider type, e.g. `"jira"`, `"github"`, `"slack"`.
- `url` — optional instance/base API URL.
- `project` — optional project, team, or workspace scope.
- `mcpUrl` — optional remote MCP endpoint the biodome-mcp aggregator connects to.
- `authHeader` — header name for the credential (default `"Authorization"`).
- `authScheme` — prefix prepended to the credential when sending (default `"Bearer "`).
- `authCredential` — which key in `credentials` holds the token (default `"token"`).
- `credentials` — map of named credentials. Each value is either a literal string or an `{ env: "VAR_NAME" }` reference.
- `metadata` — optional map of free-form string key/value pairs.

### Code mode

When MCP is enabled, the server exposes exactly three provider tools regardless of how many providers or upstream tools are connected:

- `provider_search` — discover available tools across all providers by keyword
- `provider_describe` — get the full input schema for a specific tool
- `provider_execute` — call a tool by its qualified name (`provider.tool`)

Credentials are attached by the biodome-mcp server and never reach the agent or its container.

## `addMcpProvider(spec)`

Generic helper for declaring a remote MCP provider. Connects to a provider-hosted MCP endpoint and exposes all its tools through the code-mode facade.

```javascript
export default function sentry(ctx) {
  ctx.addMcpProvider({
    name: "sentry",
    type: "sentry",
    mcpUrl: "https://mcp.sentry.dev/mcp",
    credentials: { token: { env: "SENTRY_TOKEN" } },
  });
}
```

- `name` — unique identifier.
- `type` — provider type label.
- `mcpUrl` — vendor MCP endpoint URL.
- `authHeader` — header name (default `"Authorization"`).
- `authScheme` — scheme prefix (default `"Bearer "`).
- `project` — optional project or workspace scope.
- `credentials.token` — the credential value (literal or `{ env }` reference).
- `metadata` — optional free-form key/value pairs.

## Sugar helpers

These helpers preset the vendor MCP URL and credential key, and delegate to `addMcpProvider`.

### `addJiraProvider(spec)`

```javascript
export default function jira(ctx) {
  ctx.addJiraProvider({
    name: "jira",
    project: "PROJ",
    credentials: { token: { env: "JIRA_TOKEN" } },
  });
}
```

Defaults `mcpUrl` to `https://mcp.atlassian.com/v1/mcp/authv2`.

### `addLinearProvider(spec)`

```javascript
export default function linear(ctx) {
  ctx.addLinearProvider({
    name: "linear",
    team: "TEAM",
    credentials: { token: { env: "LINEAR_TOKEN" } },
  });
}
```

Defaults `mcpUrl` to `https://mcp.linear.app/mcp`. Accepts `team` (maps to `project`).

### `addSentryProvider(spec)`

```javascript
export default function sentry(ctx) {
  ctx.addSentryProvider({
    name: "sentry",
    credentials: { token: { env: "SENTRY_TOKEN" } },
  });
}
```

Defaults `mcpUrl` to `https://mcp.sentry.dev/mcp`.

### `addSlackProvider(spec)`

```javascript
export default function slack(ctx) {
  ctx.addSlackProvider({
    name: "slack",
    mcpUrl: "https://slack.example.com/mcp",
    credentials: { token: { env: "SLACK_TOKEN" } },
  });
}
```

`mcpUrl` is **required** — there is no stable public default.

### `addGithubProvider(spec)`

```javascript
export default function github(ctx) {
  ctx.addGithubProvider({
    name: "github",
    credentials: { token: { env: "GITHUB_TOKEN" } },
  });
}
```

Defaults `mcpUrl` to `https://api.githubcopilot.com/mcp/`.

## `addEnv(key, spec)`

Declares an environment variable. A variable is either a **literal** value or a **passthrough** reference that is resolved from the host at `up` time — the safe way to inject secrets without baking them into the image or `plan.json`.

```javascript
export default function env(ctx) {
  // Literal, non-secret config. Baked into the image / plan.
  ctx.addEnv("DEBUG", { value: "1" });

  // Passthrough: value is read from the host's DATABASE_URL at `up` time and is
  // NEVER written to the Dockerfile or plan.json.
  ctx.addEnv("DATABASE_URL", { from: { env: "DATABASE_URL" }, required: true });

  // Passthrough with a fallback default.
  ctx.addEnv("PORT", { from: { env: "PORT" }, default: "8000" });

  // Build-time-only literal.
  ctx.addEnv("PIP_INDEX_URL", { value: "https://pypi.org/simple", scope: "build" });
}
```

The spec accepts exactly one of:

- `value` — a literal string. Stored in the plan and baked into the image `ENV` layer / compose file.
- `from` — `{ env: "VAR_NAME" }`, passed through from the host environment via compose interpolation. The value is never persisted.

Plus:

- `scope` — `"runtime"` (default), `"build"`, or `"both"`. Controls whether the variable is available at image build time, container runtime, or both.
- `required` — passthrough only. Fails `biodome up` if the host variable is unset.
- `default` — passthrough only. Fallback used when the host variable is unset or empty.

Keys must match `[A-Za-z_][A-Za-z0-9_]*`, and each key may only be declared once.

### Literal vs passthrough

Use `value` for non-secret configuration you're happy to see in the built image and `plan.json`. Use `from` for anything sensitive (API keys, database URLs, tokens): passthrough variables are emitted as `${VAR}` interpolations in the generated compose file and resolved from the host shell / `.env` at `up` time, so the secret never lands in a committed artifact.

## `addVolume(spec)`

Mounts data into the dev container as a live read/write access point. Supports local bind mounts and cloud or network storage via `rclone`. No files are copied into the container.

```javascript
export default function volumes(ctx) {
  // Local bind mount
  ctx.addVolume({
    name: "data",
    type: "local",
    source: "./data",
    target: "/workspace/data",
  });

  // S3 bucket or prefix mount
  ctx.addVolume({
    name: "s3-data",
    type: "s3",
    bucket: "my-bucket",
    prefix: "data/",
    target: "/workspace/s3-data",
    credentials: {
      accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
      secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
    },
  });

  // S3-compatible service (MinIO, Wasabi, Cloudflare R2, ...)
  ctx.addVolume({
    name: "minio",
    type: "s3",
    bucket: "my-bucket",
    target: "/workspace/minio",
    credentials: {
      accessKeyId: { env: "MINIO_ACCESS_KEY" },
      secretAccessKey: { env: "MINIO_SECRET_KEY" },
      endpoint: "http://minio:9000",
    },
  });

  // Dropbox mount
  ctx.addVolume({
    name: "dropbox",
    type: "dropbox",
    path: "/Projects",
    target: "/workspace/dropbox",
    credentials: { token: { env: "DROPBOX_TOKEN" } },
  });

  // Google Drive mount
  ctx.addVolume({
    name: "gdrive",
    type: "gdrive",
    path: "/Documents",
    target: "/workspace/gdrive",
    credentials: {
      clientId: { env: "GDRIVE_CLIENT_ID" },
      clientSecret: { env: "GDRIVE_CLIENT_SECRET" },
      token: { env: "GDRIVE_TOKEN" },
    },
  });
}
```

- `name` — unique identifier.
- `type` — `"local"`, `"s3"`, `"gcs"`, `"azure"`, `"sftp"`, `"smb"`, `"webdav"`, `"dropbox"`, or `"gdrive"`.
- `target` — absolute path inside the dev container.
- `source` — local host path for `type: "local"`. Relative paths are resolved from the project root.
- `bucket` / `prefix` — S3 or GCS location. Mount a prefix to access specific files inside it.
- `account` / `container` / `path` — Azure Blob location.
- `host` / `port` / `path` — SFTP location.
- `host` / `share` — SMB share.
- `url` / `path` / `vendor` — WebDAV location.
- `path` — remote folder path for Dropbox or Google Drive.
- `credentials` — map of provider credentials. Each value is either a literal string or an `{ env: "VAR_NAME" }` reference. Env references are resolved from the host at `up` time and never written to the generated files.
- `options.readOnly` — set to `"true"` for read-only mounts (local only).

Cloud-backed volumes install `rclone` and `fuse3` in the dev container, enable privileged mode, and run an `rclone mount` daemon process. Files are read and written directly against the remote source.

### Proxy mode (agent-safe access)

By default, cloud volumes are mounted inside the dev container, so any process or agent in the container can read them. If you want to keep credentials and data access away from the sandbox, enable **proxy mode**:

```javascript
export default function volumes(ctx) {
  ctx.addS3Volume({
    name: "s3-data",
    bucket: "my-bucket",
    prefix: "reports/",
    target: "/workspace/s3-data",
    proxy: true,
    readOnly: true,
    allowedPaths: ["reports/**/*.pdf"],
    credentials: {
      accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
      secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
    },
  });
}
```

In proxy mode:

- The volume is **not mounted** in the dev container.
- Credentials are passed only to the MCP server process, never to the dev container's global environment.
- Agents access files through MCP tools: `list_volumes`, `list_files`, `read_file`, `write_file`, `stat_file`.
- Access rules are enforced by the MCP server (`allowedPaths`, `readOnly`).

Proxy mode is supported for `local`, `s3`, `gcs`, and `azure` volumes. Other volume types still fall back to `rclone` mount.

### Volume wrappers

For a simpler DX you can use provider-specific wrappers. They delegate to `addVolume` but accept friendlier field names.

```javascript
export default function volumes(ctx) {
  ctx.addLocalVolume({ name: "data", source: "./data", target: "/workspace/data" });

  ctx.addS3Volume({
    name: "s3-data",
    bucket: "my-bucket",
    prefix: "data/",
    target: "/workspace/s3-data",
    credentials: {
      accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
      secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
    },
  });

  ctx.addGcsVolume({
    name: "gcs-data",
    bucket: "my-bucket",
    prefix: "data/",
    target: "/workspace/gcs-data",
    credentials: { token: { env: "GCS_TOKEN" } },
  });

  ctx.addAzureVolume({
    name: "azure-data",
    account: "myaccount",
    container: "mycontainer",
    path: "data/",
    target: "/workspace/azure-data",
    credentials: { accountKey: { env: "AZURE_KEY" } },
  });

  ctx.addSftpVolume({
    name: "sftp-data",
    host: "files.example.com",
    path: "/srv/data",
    target: "/workspace/sftp-data",
    credentials: { user: "admin", password: { env: "SFTP_PASS" } },
  });

  ctx.addSmbVolume({
    name: "smb-data",
    host: "nas.local",
    share: "shared",
    target: "/workspace/smb-data",
    credentials: { user: { env: "SMB_USER" }, password: { env: "SMB_PASS" } },
  });

  ctx.addWebdavVolume({
    name: "webdav-data",
    url: "https://cloud.example.com/webdav",
    path: "projects",
    target: "/workspace/webdav-data",
    credentials: { user: "admin", password: { env: "WEBDAV_PASS" } },
  });

  ctx.addDropboxVolume({
    name: "dropbox",
    path: "/Projects",
    target: "/workspace/dropbox",
    credentials: { token: { env: "DROPBOX_TOKEN" } },
  });

  ctx.addGdriveVolume({
    name: "gdrive",
    path: "/Documents",
    target: "/workspace/gdrive",
    credentials: {
      clientId: { env: "GDRIVE_CLIENT_ID" },
      clientSecret: { env: "GDRIVE_CLIENT_SECRET" },
      token: { env: "GDRIVE_TOKEN" },
    },
  });
}
```

## `addRepo(spec)`

Declares a Git repository that should be cloned into the sandbox. When the sandbox starts, biodome runs a generated `start.post` hook that clones the repo if it is not present, or fetches, checks out, and pulls the tracked branch if it already is. This is useful for polyglot or microservice projects where the agent needs multiple repositories side by side.

```javascript
export default function repos(ctx) {
  ctx.addRepo({
    name: "backend",
    url: "https://github.com/acme/backend.git",
    branch: "main",
    path: "backend",
  });

  ctx.addRepo({
    name: "frontend",
    url: "https://github.com/acme/frontend.git",
    branch: "develop",
    path: "frontend",
  });
}
```

- `name` — unique identifier for the repo.
- `url` — Git clone URL (`https://...` or `git@...`).
- `branch` — branch to track. Defaults to `"main"`.
- `path` — target directory inside the sandbox. Relative paths are resolved under `/workspace`; absolute paths are used as-is. Defaults to `/workspace/repos/<name>`.
- `depth` — optional shallow clone depth (e.g. `1`).
- `credentials` — optional authentication. Both values must be environment references (`{ env: "VAR" }`) so secrets never touch `plan.json` or the generated scripts.
  - `token` — for HTTPS URLs. Injected as `https://$TOKEN@host/...`.
  - `sshKey` — for SSH URLs. Written to a temporary key file and used via `GIT_SSH_COMMAND`.

Each repo generates a sync script at `.biodome-build/repos/<name>.sh` and a `start.post` hook named `repo-sync-<name>`. `git` and `openssh-client` are automatically installed in the dev image when any repo is declared.

## `addOpencodeHarness(spec)`

Runs a headless OpenCode agent inside the sandbox. The harness installs the OpenCode CLI (`opencode-ai`), the Bun runtime, and starts `opencode serve` as a daemon process. It also generates an isolated OpenCode config that registers `biodome-mcp` as an MCP server, includes any declared LLM providers, and installs a telemetry plugin that records every message, tool call, and event the agent emits.

```javascript
export default function agent(ctx) {
  ctx.addOpencodeHarness({
    name: "coder",
    port: 3002,
    mcpServers: {
      biodome: { url: "http://localhost:3001" },
    },
    telemetry: {
      enabled: true,
      path: "/workspace/.biodome-build/logs/opencode-events.jsonl",
    },
  });
}
```

- `name` — unique identifier for the harness.
- `port` — port for `opencode serve`. Defaults to `3002`.
- `mcpServers` — map of MCP servers the agent can use. Defaults to `{ biodome: { url: "http://localhost:<mcpPort>" } }`.
- `telemetry` —
  - `enabled` — whether to install the telemetry plugin. Defaults to `true`.
  - `path` — JSONL file where OpenCode events are written. Defaults to `/workspace/.biodome-build/logs/opencode-events.jsonl`.
- `config` — arbitrary extra values merged into `opencode.json`.

The MCP server (`biodome-mcp`) writes its own structured events to `/workspace/.biodome-build/logs/mcp-events.jsonl`. Together, the two logs give a holistic view of the agent's activity: OpenCode events show the agent's reasoning and tool calls, while the MCP log shows the exact sandbox actions those tool calls performed.

## `addLlmProvider(spec)`

Configures an LLM provider for OpenCode harnesses. The provider is written into each generated OpenCode config under the `provider` key, and credential env references are substituted at container startup so secrets never live in `plan.json` or the generated config files.

```javascript
export default function llm(ctx) {
  ctx.addLlmProvider({
    name: "lmstudio",
    npm: "@ai-sdk/openai-compatible",
    displayName: "LM Studio",
    options: {
      baseURL: "http://localhost:2877/v1",
      apiKey: { env: "LMSTUDIO_API_KEY" },
    },
    models: {
      "local-model": { name: "Local Model" },
    },
  });
}
```

- `name` — unique provider key.
- `npm` — optional npm package for the provider SDK.
- `displayName` — human-readable provider name.
- `options` — provider options such as `baseURL` and `apiKey`. Credential-like option keys (containing `key`) must be env references.
- `models` — map of model IDs to display names.

## Health checks

Health checks are attached to daemon processes. Each daemon with a health check gets a generated shell script in `.biodome-build/healthchecks/<name>.sh`, and `supervisord` runs a companion `<name>-healthcheck` program that restarts the process after repeated failures. The dev service health check in the generated compose file runs all daemon health checks via `.biodome-build/healthchecks/all.sh`.

```javascript
export default function api(ctx) {
  ctx.addProcess({
    name: "api",
    command: ["node", "server.js"],
    port: 3000,
    healthCheck: {
      type: "http",
      url: "http://localhost:3000/health",
      interval: "5s",
      timeout: "3s",
      retries: 10,
    },
  });
}
```

Supported types:

- `http` — checks via `curl`. Default type.
- `tcp` — checks via `nc` (netcat is installed automatically).
- `exec` — runs a custom command.

For `http`, if `url` is omitted, it is derived from the declared port.

## Reading the project

Features can inspect the project before contributing.

```javascript
export default function detect(ctx) {
  if (ctx.fileExists("pyproject.toml")) {
    ctx.addLanguage("python", { version: "3.12", packageManager: "poetry" });
  } else {
    ctx.addLanguage("python", { version: "3.12" });
  }

  const pkg = ctx.readJSON("package.json");
  if (pkg?.dependencies?.next) {
    ctx.addTool("vercel");
  }
}
```

## Running commands

Features can run arbitrary commands during plan generation.

```javascript
export default function branchEnv(ctx) {
  const result = ctx.exec("git branch --show-current");
  const branch = result.stdout.trim();

  if (branch !== "main") {
    ctx.addEnv("DEBUG", { value: "1" });
  }
}
```

Commands are logged to stdout. Read-only commands such as `info`, `config validate`, and `generate agents.md` run feature modules in dry-run mode, so `ctx.exec` returns empty output and does not shell out.
