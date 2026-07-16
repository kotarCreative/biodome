# Primitives

Primitives are the building blocks of a sandbox. You add them through the context object passed to your feature modules.

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
}
```

Language setup affects:

- The base Docker image.
- Which manifest files are copied.
- How dependencies are installed.
- What artifacts are copied into the final dev stage.

Manifest files are detected from the project root. For example, Node.js uses `npm ci` when `package-lock.json` exists and falls back to `npm install` when only `package.json` exists. If no manifest is present, only the base image is configured and no dependency install step is emitted.

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

## `setEnv(key, value)`

Sets an environment variable available in both the build and runtime environments.

```javascript
export default function env(ctx) {
  ctx.setEnv("DEBUG", "1");
}
```

## Health checks

Health checks are attached to daemon processes. Each daemon with a health check gets a generated shell script in `.sandbox/healthchecks/<name>.sh`, and `supervisord` runs a companion `<name>-healthcheck` program that restarts the process after repeated failures. The dev service health check in the generated compose file runs all daemon health checks via `.sandbox/healthchecks/all.sh`.

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
    ctx.setEnv("DEBUG", "1");
  }
}
```

Commands are logged to stdout. Read-only commands such as `info`, `config validate`, and `generate agents.md` run feature modules in dry-run mode, so `ctx.exec` returns empty output and does not shell out.
