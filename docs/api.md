# API reference

Feature files are evaluated in a Node.js VM with a `sandbox` global. The only API you need is `sandbox.ctx()`.

## `sandbox.ctx()`

Returns the `FeatureContext` for the current project. All contributions mutate the shared Plan.

```javascript
const ctx = sandbox.ctx();
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

### `addPackage(manager, name, options)`

Install a package.

- `manager`: `"npm"`, `"pip"`, `"cargo"`, `"go"`, `"gem"`
- `name`: package name
- `options.version`: optional version
- `options.indexUrl`: optional package index URL

### `addTool(name, options)`

Install a CLI tool or system package. Well-known tools use custom install scripts; unknown names are installed via apt.

- `name`: `"gh"`, `"kubectl"`, `"terraform"`, `"psql"`, `"redis-cli"`, `"docker"`, or any apt package name

### `addService(name, options)`

Add a backing service. See [File layout](file-layout.md).

### `setEnv(key, value)`

Set an environment variable for both build and runtime.

### `fileExists(path)`

Check if a file exists relative to the project root.

```javascript
if (ctx.fileExists("vite.config.ts")) {
  // ...
}
```

### `readFile(path)`

Read a file as a UTF-8 string.

```javascript
const content = ctx.readFile("README.md");
```

### `readJSON(path)`

Read and parse a JSON file.

```javascript
const pkg = ctx.readJSON("package.json");
```

### `exec(command)`

Run a shell command on the host during plan generation.

```javascript
const result = ctx.exec("git branch --show-current");
console.log(result.stdout);
console.log(result.stderr);
console.log(result.exitCode);
```

All commands are logged to stdout.

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

### `sandbox init`

Create a `sandbox/` directory with a starter config.

### `sandbox build`

Generate `.sandbox/Dockerfile`, `.sandbox/docker-compose.yaml`, `.dockerignore`, and build the dev image.

### `sandbox up [--build] [--wait]`

Start the dev container and backing services with Docker Compose. Use `--build` to force a rebuild. Use `--wait` to keep the CLI alive until Ctrl+C.

### `sandbox down`

Stop and remove the dev container and backing services.

### `sandbox exec <command...>`

Run a command inside the dev container.

```bash
sandbox exec npm test
```

### `sandbox info`

Print a summary of the project: base image, services, ports, connection strings, processes, and hooks.

### `sandbox config validate`

Validate the `sandbox/` configuration without building.

### `sandbox generate agents.md`

Generate an `AGENTS.md` file with connection info and available commands for AI coding agents.
