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

Declares an agent-discoverable endpoint — a custom API or resource a feature stands up — along with how to reach it and any credentials needed to use it. Endpoints appear in `biodome info`, the generated `AGENTS.md`, `.biodome/plan.json`, and the MCP `get_endpoints` tool, so an agent can discover the port, URL, credentials, and metadata for a service you created.

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

- **Literal** (`password: "devpassword"`) — stored verbatim. Convenient for throwaway local dev values, but it is written to `.biodome/plan.json` and surfaced by every info surface.
- **Env reference** (`password: { env: "DJANGO_ADMIN_PASSWORD" }`) — the secret stays out of `plan.json` and the generated `AGENTS.md` (they show `$DJANGO_ADMIN_PASSWORD`). The MCP `get_endpoints` tool resolves the reference from the container's live environment when an agent asks, so real secrets are never persisted on disk.

Prefer env references for anything sensitive.

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

## Health checks

Health checks are attached to daemon processes. Each daemon with a health check gets a generated shell script in `.biodome/healthchecks/<name>.sh`, and `supervisord` runs a companion `<name>-healthcheck` program that restarts the process after repeated failures. The dev service health check in the generated compose file runs all daemon health checks via `.biodome/healthchecks/all.sh`.

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
