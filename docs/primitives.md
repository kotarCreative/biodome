# Primitives

Primitives are the building blocks of a sandbox. You add them through `sandbox.ctx()` inside your feature files.

## `addProcess(spec)`

Declares a long-running process managed by `supervisord` inside the dev container. Daemon processes are started automatically when the container starts, expose ports, and can have health checks.

```javascript
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
  env: { DEBUG: "1" },
});
```

- `name` — unique identifier.
- `command` — array of command arguments.
- `port` — single port to expose (host and container use the same port).
- `ports` — named ports, e.g. `{ app: 8000, debug: 5678 }`.
- `env` — environment variables for the process.
- `workingDir` — working directory inside the container.
- `healthCheck` — see [health checks](#health-checks).
- `mode` — defaults to `"daemon"`. Set to `"oneshot"` for a one-shot command.
- `startOn` — lifecycle point for one-shot commands. Defaults to `"start.post"`.

## `addHook(spec)`

Sugar for `addProcess({ mode: "oneshot", ... })`. Hooks run once at a specific lifecycle point.

```javascript
ctx.addHook({
  name: "migrate",
  command: ["python", "manage.py", "migrate"],
  startOn: "start.post",
});
```

Lifecycle points:

- `build.pre` / `build.post`
- `start.pre` / `start.post`
- `stop.pre` / `stop.post`
- `exec.pre` / `exec.post`

## `addLanguage(name, options)`

Adds a language runtime and configures dependency installation.

```javascript
ctx.addLanguage("python", { version: "3.12" });
ctx.addLanguage("node", { version: "20", packageManager: "pnpm" });
ctx.addLanguage("go", { version: "1.22" });
ctx.addLanguage("rust", { version: "1.75" });
ctx.addLanguage("java", { version: "21" });
```

Language setup affects:

- The base Docker image.
- Which manifest files are copied.
- How dependencies are installed.
- What artifacts are copied into the final dev stage.

## `addPackage(manager, name, options)`

Installs a package through a language-specific package manager.

```javascript
ctx.addPackage("npm", "typescript", { version: "5.4" });
ctx.addPackage("pip", "django", { version: "5.0" });
ctx.addPackage("apt", "libpq-dev");
ctx.addPackage("cargo", "ripgrep");
ctx.addPackage("go", "github.com/air-verse/air");
ctx.addPackage("gem", "bundler");
```

## `addAptPackage(name)`

Installs a Debian package via `apt`. Automatically deduplicates.

```javascript
ctx.addAptPackage("curl");
ctx.addAptPackage("git");
```

## `addTool(name, options)`

Installs a well-known CLI tool.

```javascript
ctx.addTool("gh");
ctx.addTool("kubectl");
ctx.addTool("terraform");
ctx.addTool("psql");
ctx.addTool("redis-cli");
ctx.addTool("docker");
```

## `addService(name, options)`

Declares a backing service. See [services in file-layout.md](file-layout.md) for details.

```javascript
ctx.addService("postgres", {
  port: 5432,
  databases: [{ name: "myapp" }],
  users: [{ name: "myapp", password: "devpassword" }],
});
```

## `setEnv(key, value)`

Sets an environment variable available in both the build and runtime environments.

```javascript
ctx.setEnv("DEBUG", "1");
```

## Health checks

Health checks are attached to daemon processes and, in the generated compose file, to the dev service.

```javascript
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
```

Supported types:

- `http` — checks via `curl`. Default type.
- `tcp` — checks via `nc`.
- `exec` — runs a custom command.

For `http`, if `url` is omitted, it is derived from the declared port.

## Reading the project

Features can inspect the project before contributing.

```javascript
const ctx = sandbox.ctx();

if (ctx.fileExists("pyproject.toml")) {
  ctx.addLanguage("python", { version: "3.12", packageManager: "poetry" });
} else {
  ctx.addLanguage("python", { version: "3.12" });
}

const pkg = ctx.readJSON("package.json");
if (pkg?.dependencies?.next) {
  ctx.addTool("vercel");
}
```

## Running commands

Features can run arbitrary commands during plan generation.

```javascript
const ctx = sandbox.ctx();
const result = ctx.exec("git branch --show-current");
const branch = result.stdout.trim();

if (branch !== "main") {
  ctx.setEnv("DEBUG", "1");
}
```

Commands are logged to stdout.
