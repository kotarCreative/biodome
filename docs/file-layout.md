# File layout

Every biodome project has a `.biodome/` directory at the repository root. The directory contains metadata, services, implicit application entries, and feature files. Generated build artifacts are written to `.biodome-build/` so config and generated output stay separate.

```
my-project/
├── .biodome/
│   ├── config.json          # project metadata
│   ├── services.mjs         # backing services
│   ├── apps/
│   │   ├── backend.mjs      # implicit application declaration
│   │   └── frontend.mjs
│   ├── lib/                 # explicitly imported app helpers; never auto-loaded
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
│   │       ├── artifacts/
│   │       ├── state.json
│   │       └── logs/
│   │           ├── events-<runId>.jsonl
│   │           └── runs/<runId>.json
├── .dockerignore            # generated
└── .gitignore               # includes the `.biodome-build/` entry
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

All backing services run as ephemeral, supervised processes inside the dev
container under dedicated system accounts — a deployment is exactly one image.
Supported types: `postgres` and `redis`. Use `ctx.addService()` for each service.

> Legacy `.js` extensions are also supported (`.biodome/services.js`).

```javascript
export default function services(ctx) {
  ctx.addService("postgres", {
    port: 5432,
    databases: [{ name: "myapp" }],
    users: [{ name: "myapp", password: "devpassword" }],
    extensions: ["postgis", "pgcrypto"],
  });

  ctx.addService("redis", { port: 6379 });
}
```

## `.biodome/features/*.mjs`

Feature files declare languages, packages, tools, processes, and hooks. They are loaded in sorted order and each receives the shared context.

> Legacy `.js` extensions are also supported (`.biodome/features/*.js`).

## `.biodome/apps/*.mjs`

Applications are immediate implicit entrypoints loaded after services and before
features. One file declares one app, using the filename as its name. Apps expand
recipes or local functions into the same repositories, hooks, processes, and
endpoints used elsewhere in Biodome. See [Applications and recipes](apps.md).

```javascript
// .biodome/features/python.mjs
export default function python(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addTool("libpq-dev");
  ctx.addPackage("pip", "django", { version: "5.0" });
}
```

## Generated files

After running `biodome build <target>` or `biodome up <target>`, the CLI writes
target-specific runtime files below `.biodome-build/targets/<target>/`:

- `Dockerfile` — multi-stage image for the dev container.
- `supervisord.conf` — process manager config for daemon processes.
- `docker-compose.yaml` — the dev service and any container-hosted backing services when the target uses Docker Compose.
- `healthchecks/*.sh` — per-process health check and monitor scripts, plus an aggregate `all.sh`.
- `repos/`, `services/`, and harness-home directories — generated repository, in-container service, and agent-harness helpers.
- `artifacts/` — files collected after a successful named task.
- `logs/events-<runId>.jsonl` and `logs/runs/<runId>.json` — structured lifecycle events and durable task-run records.
- `state.json` — the provider state used to reuse or clean up the target.

The generated `.dockerignore` remains at the project root because Docker reads it
from the build context. Do not edit generated runtime files directly; they are
refreshed for the selected target.
