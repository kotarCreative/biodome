# File layout

Every biodome project has a `.biodome/` directory at the repository root. The directory contains metadata, services, and feature files. Generated build artifacts are written to `.biodome-build/` so config and generated output stay separate.

```
my-project/
├── .biodome/
│   ├── config.json          # project metadata
│   ├── services.mjs         # backing services
│   ├── features/
│   │   ├── django.mjs       # daemon process
│   │   ├── migrate.mjs      # one-shot hook
│   │   ├── python.mjs       # language runtime
│   │   └── npm-tools.mjs    # tools and packages
│   ├── targets/
│   │   └── local.mjs        # default Docker Compose target
│   └── tasks/
│       └── .gitkeep         # named task declarations
├── .biodome-build/
│   ├── targets/
│   │   └── local/           # target-scoped generated artifacts
│   │       ├── Dockerfile
│   │       ├── supervisord.conf
│   │       ├── docker-compose.yaml
│   │       ├── healthchecks/
│   │       ├── state.json
│   │       └── logs/
│   └── logs/                # global event logs
│       └── events-<runId>.jsonl
├── .dockerignore            # generated
└── .gitignore               # `.biodome-build/` entry added by `biodome build`
```

## `.biodome/config.json`

Static metadata for the project. Currently only the project name is required.

```json
{
  "project": {
    "name": "my-project"
  }
}
```

## `.biodome/services.mjs`

Backing services run as separate containers. Use `ctx.addService()` for each service.

> Legacy `.js` extensions are also supported (`.biodome/services.js`).

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

## `.biodome/features/*.mjs`

Feature files declare languages, packages, tools, processes, and hooks. They are loaded in sorted order and each receives the shared context.

> Legacy `.js` extensions are also supported (`.biodome/features/*.js`).

```javascript
// .biodome/features/python.mjs
export default function python(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addTool("libpq-dev");
  ctx.addPackage("pip", "django", { version: "5.0" });
}
```

## Generated files

After running `biodome build` or `biodome up`, the CLI writes:

- `.biodome-build/Dockerfile` — multi-stage image for the dev container.
- `.biodome-build/supervisord.conf` — process manager config for daemon processes.
- `.biodome-build/docker-compose.yaml` — backing services and dev service.
- `.biodome-build/healthchecks/*.sh` — per-process health check and monitor scripts, plus an aggregate `all.sh`.
- `.biodome-build/logs/events-<runId>.jsonl` — structured event log for each run.
- `.dockerignore` — build context exclusions.

Do not edit these files directly. They are regenerated each time.
