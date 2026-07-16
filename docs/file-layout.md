# File layout

Every biodome project has a `biodome/` directory at the repository root. The directory contains metadata, services, and feature files.

```
my-project/
├── biodome/
│   ├── config.json          # project metadata
│   ├── services.mjs         # backing services
│   └── features/
│       ├── django.mjs       # daemon process
│       ├── migrate.mjs      # one-shot hook
│       ├── python.mjs       # language runtime
│       └── npm-tools.mjs    # tools and packages
├── .biodome/
│   ├── Dockerfile           # generated
│   ├── supervisord.conf     # generated
│   ├── docker-compose.yaml  # generated
│   └── healthchecks/        # generated
│       ├── <process>.sh
│       ├── <process>-monitor.sh
│       └── all.sh
└── .dockerignore            # generated
```

## `biodome/config.json`

Static metadata for the project. Currently only the project name is required.

```json
{
  "project": {
    "name": "my-project"
  }
}
```

## `biodome/services.mjs`

Backing services run as separate containers. Use `ctx.addService()` for each service.

> Legacy `.js` extensions are also supported (`biodome/services.js`).

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

## `biodome/features/*.mjs`

Feature files declare languages, packages, tools, processes, and hooks. They are loaded in sorted order and each receives the shared context.

> Legacy `.js` extensions are also supported (`biodome/features/*.js`).

```javascript
// biodome/features/python.mjs
export default function python(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addTool("libpq-dev");
  ctx.addPackage("pip", "django", { version: "5.0" });
}
```

## Generated files

After running `biodome build` or `biodome up`, the CLI writes:

- `.biodome/Dockerfile` — multi-stage image for the dev container.
- `.biodome/supervisord.conf` — process manager config for daemon processes.
- `.biodome/docker-compose.yaml` — backing services and dev service.
- `.biodome/healthchecks/*.sh` — per-process health check and monitor scripts, plus an aggregate `all.sh`.
- `.dockerignore` — build context exclusions.

Do not edit these files directly. They are regenerated each time.
