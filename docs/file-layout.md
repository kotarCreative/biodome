# File layout

Every sandbox project has a `sandbox/` directory at the repository root. The directory contains metadata, services, and feature files.

```
my-project/
├── sandbox/
│   ├── config.json          # project metadata
│   ├── services.mjs         # backing services
│   └── features/
│       ├── django.mjs       # daemon process
│       ├── migrate.mjs      # one-shot hook
│       ├── python.mjs       # language runtime
│       └── npm-tools.mjs    # tools and packages
├── .sandbox/
│   ├── Dockerfile           # generated
│   ├── supervisord.conf     # generated
│   ├── docker-compose.yaml  # generated
│   └── healthchecks/        # generated
│       ├── <process>.sh
│       ├── <process>-monitor.sh
│       └── all.sh
└── .dockerignore            # generated
```

## `sandbox/config.json`

Static metadata for the project. Currently only the project name is required.

```json
{
  "project": {
    "name": "my-project"
  }
}
```

## `sandbox/services.mjs`

Backing services run as separate containers. Use `ctx.addService()` for each service.

> Legacy `.js` extensions are also supported (`sandbox/services.js`).

```javascript
export default function services(ctx) {
  ctx.addService("postgres", {
    port: 5432,
    databases: [{ name: "myapp" }],
    users: [{ name: "myapp", password: "devpassword" }],
  });

  ctx.addService("redis", { port: 6379 });
}
```

## `sandbox/features/*.mjs`

Feature files declare languages, packages, tools, processes, and hooks. They are loaded in sorted order and each receives the shared context.

> Legacy `.js` extensions are also supported (`sandbox/features/*.js`).

```javascript
// sandbox/features/python.mjs
export default function python(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addTool("libpq-dev");
  ctx.addPackage("pip", "django", { version: "5.0" });
}
```

## Generated files

After running `sandbox build` or `sandbox up`, the CLI writes:

- `.sandbox/Dockerfile` — multi-stage image for the dev container.
- `.sandbox/supervisord.conf` — process manager config for daemon processes.
- `.sandbox/docker-compose.yaml` — backing services and dev service.
- `.sandbox/healthchecks/*.sh` — per-process health check and monitor scripts, plus an aggregate `all.sh`.
- `.dockerignore` — build context exclusions.

Do not edit these files directly. They are regenerated each time.
