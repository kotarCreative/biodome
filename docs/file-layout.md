# File layout

Every sandbox project has a `sandbox/` directory at the repository root. The directory contains metadata, services, and feature files.

```
my-project/
├── sandbox/
│   ├── config.json          # project metadata
│   ├── services.js          # backing services
│   └── features/
│       ├── django.js        # daemon process
│       ├── migrate.js       # one-shot hook
│       ├── python.js        # language runtime
│       └── npm-tools.js     # tools and packages
├── .sandbox/
│   ├── Dockerfile           # generated
│   ├── supervisord.conf     # generated
│   └── docker-compose.yaml  # generated
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

## `sandbox/services.js`

Backing services run as separate containers. Use `ctx.addService()` for each service.

```javascript
const ctx = sandbox.ctx();

ctx.addService("postgres", {
  port: 5432,
  databases: [{ name: "myapp" }],
  users: [{ name: "myapp", password: "devpassword" }],
});

ctx.addService("redis", { port: 6379 });
```

## `sandbox/features/*.js`

Feature files declare languages, packages, tools, processes, and hooks. They are evaluated in sorted order with a shared `sandbox.ctx()`.

```javascript
// sandbox/features/python.js
const ctx = sandbox.ctx();

ctx.addLanguage("python", { version: "3.12" });
ctx.addAptPackage("libpq-dev");
ctx.addPackage("pip", "django", { version: "5.0" });
```

## Generated files

After running `sandbox build` or `sandbox up`, the CLI writes:

- `.sandbox/Dockerfile` — multi-stage image for the dev container.
- `.sandbox/supervisord.conf` — process manager config for daemon processes.
- `.sandbox/docker-compose.yaml` — backing services and dev service.
- `.dockerignore` — build context exclusions.

Do not edit these files directly. They are regenerated each time.
