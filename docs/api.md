# API reference

Feature files are ECMAScript modules. Each file must export a default function that receives the `FeatureContext` for the current project.

```javascript
export default function example(ctx) {
  // contribute to the shared Plan
}
```

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

### `addEnv(key, spec)`

Declare an environment variable. Provide exactly one of `value` (literal) or `from: { env }` (host passthrough). Optional: `scope` (`"build" | "runtime" | "both"`, default `"runtime"`), and for passthrough vars `required` and `default`. Passthrough values are resolved from the host at `up` time and never written to the image or `plan.json`. See [Primitives](primitives.md#addenvkey-spec).

### `addVolume(spec)`

Mount a local directory or cloud storage into the dev container. Supported types: `"local"`, `"s3"`, `"s3-file"`, `"dropbox"`, `"gdrive"`. Credentials can be literal strings or env references. See [Primitives](primitives.md#addvolumespec).

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

### `biodome build`

Generate `.biodome-build/Dockerfile`, `.biodome-build/docker-compose.yaml`, `.biodome-build/supervisord.conf` (when there are daemon processes), `.biodome-build/healthchecks/*.sh` (when there are daemon processes with health checks), `.dockerignore`, and build the dev image.

### `biodome up [--build] [--wait]`

Start the dev container and backing services with Docker Compose. Use `--build` to force a rebuild. Use `--wait` to keep the CLI alive until Ctrl+C.

### `biodome down`

Stop and remove the dev container and backing services.

### `biodome exec <command...>`

Run a command inside the dev container.

```bash
biodome exec npm test
```

### `biodome info`

Print a summary of the project: base image, languages, services, endpoints, environment, connection strings, processes, and hooks.

### `biodome config validate`

Validate the `.biodome/` configuration and feature modules without building. This checks the config schema, validates feature/service module exports, builds the plan in dry-run mode, and runs `validatePlan` to catch port conflicts and other plan-level errors.

### `biodome generate agents.md`

Generate an `AGENTS.md` file with base image, languages, services, endpoints, environment, connection info, processes, and available commands for AI coding agents.

### `biodome logs [process]`

Tail logs from a managed process. Omit the process name to see the `supervisord` log.

### `biodome ps`

Show running containers for the project.

### `biodome status`

Report container health and the status of managed processes. This runs `docker compose ps` for container health and `supervisorctl status` inside the dev container for running processes.

### `biodome restart [process]`

Restart a managed process or all daemon processes.
