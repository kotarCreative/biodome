# Processes and hooks

Processes and hooks are the most powerful primitives because they let you run arbitrary code inside the dev container. They share the same underlying model but differ in lifecycle.

## Daemon processes

A daemon process is a long-running command managed by `supervisord` inside the dev container. It starts when the container starts, restarts on failure, and can expose ports and health checks.

Use `ctx.addProcess()` for daemons.

```javascript
// sandbox/features/django.mjs
export default function django(ctx) {
  ctx.addLanguage("python", { version: "3.12" });

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

When this feature is loaded, the CLI will:

1. Install `python:3.12-slim` as the base image.
2. Install `supervisor` in the dev container.
3. Generate a `supervisord.conf` entry for the `django` program.
4. Set the dev container CMD to `supervisord`.
5. Expose `8000:8000` in `docker-compose.yaml`.
6. Add a compose health check that hits the login URL.
7. Start the dev container and any backing services with `docker compose up`.

## One-shot hooks

A hook is a command that runs once at a specific lifecycle point. Hooks are sugar for `addProcess({ mode: "oneshot", ... })`.

```javascript
// sandbox/features/migrate.mjs
export default function migrate(ctx) {
  ctx.addHook({
    name: "migrate",
    command: ["python", "manage.py", "migrate"],
    startOn: "start.post",
  });
}
```

This runs after the dev container starts. The command executes inside the dev container via `docker exec`.

## Lifecycle points

| Point | When it runs | Where it runs |
|-------|--------------|---------------|
| `build.pre` | Before `docker compose build` | Host |
| `build.post` | After `docker compose build` | Host |
| `start.pre` | Before `docker compose up` | Host |
| `start.post` | After the dev container starts | Inside the dev container |
| `stop.pre` | Before `docker compose down` | Inside the dev container |
| `stop.post` | After `docker compose down` | Host |
| `exec.pre` | Before `biodome exec <command>` | Inside the dev container |
| `exec.post` | After `biodome exec <command>` | Inside the dev container |

## Writing custom processes

### Custom dev server

```javascript
// sandbox/features/vite.mjs
export default function vite(ctx) {
  ctx.addLanguage("node", { version: "20" });

  ctx.addProcess({
    name: "vite",
    command: ["npm", "run", "dev"],
    port: 5173,
    healthCheck: {
      type: "http",
      url: "http://localhost:5173/",
    },
  });
}
```

### Custom MCP server

```javascript
// sandbox/features/opencode-mcp.mjs
export default function opencodeMcp(ctx) {
  ctx.addProcess({
    name: "opencode-mcp",
    command: ["node", "mcp-server.js"],
    port: 3001,
    healthCheck: {
      type: "http",
      url: "http://localhost:3001/health",
    },
  });
}
```

### Stdio-based MCP server

If an MCP server uses stdio instead of a port, omit the port and health check.

```javascript
export default function stdioMcp(ctx) {
  ctx.addProcess({
    name: "stdio-mcp",
    command: ["node", "stdio-mcp-server.js"],
  });
}
```

The process will run under `supervisord` but no port is exposed.

### Conditional process

```javascript
// sandbox/features/server.mjs
export default function server(ctx) {
  if (ctx.fileExists("vite.config.ts")) {
    ctx.addProcess({
      name: "vite",
      command: ["npm", "run", "dev"],
      port: 3000,
    });
  } else if (ctx.fileExists("manage.py")) {
    ctx.addProcess({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      port: 8000,
    });
  }
}
```

### Multi-process setup

You can declare multiple processes in one feature or across features. `supervisord` manages all of them.

```javascript
// sandbox/features/app.mjs
export default function app(ctx) {
  ctx.addProcess({
    name: "backend",
    command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
    port: 8000,
  });

  ctx.addProcess({
    name: "frontend",
    command: ["npm", "run", "dev"],
    port: 3000,
    workingDir: "frontend",
  });
}
```

### Build-time hook

```javascript
// sandbox/features/codegen.mjs
export default function codegen(ctx) {
  ctx.addHook({
    name: "codegen",
    command: ["npm", "run", "generate"],
    startOn: "build.pre",
  });
}
```

This runs the command on the host during plan generation because the container does not exist yet at `build.pre`.

### Exec-time hook

```javascript
// sandbox/features/notify.mjs
export default function notify(ctx) {
  ctx.addHook({
    name: "notify",
    command: ["echo", "Running command in dev container"],
    startOn: "exec.pre",
  });
}
```

This runs every time you execute a command inside the dev container.

## Process environment

Process env vars are also merged into the runtime environment, so they are available to other processes and to commands you run with `biodome exec`.

```javascript
export default function apiEnv(ctx) {
  ctx.addProcess({
    name: "api",
    command: ["node", "server.js"],
    port: 3000,
    environment: {
      DATABASE_URL: "postgresql://localhost:5432/myapp",
    },
  });
}
```

## Notes

- Process and service names must be unique across all features.
- Commands are arrays of strings. If you need shell features, use `sh -c` as the first argument.
- Health checks with `type: "http"` automatically add `curl` to the image.
- Health checks with `type: "tcp"` automatically add `netcat-openbsd` to the image.
- Each daemon process with a health check gets a generated script in `.biodome/healthchecks/<name>.sh` and a `supervisord` monitor program (`<name>-healthcheck`) that restarts the process after repeated failures.
- The dev service health check in `docker-compose.yaml` runs all daemon health checks via `.biodome/healthchecks/all.sh`.

## Viewing process logs

Use the CLI to tail `supervisord` managed logs:

```bash
biodome logs django
biodome logs
```

Without a process name, the command tails the `supervisord` log. Logs are stored at `/tmp/<process>.log` inside the dev container by default.
