# Primitives

Each `.biodome/features/*.mjs` file contributes to one environment. Declare what
the project needs rather than maintaining generated Docker and supervisor files.

```javascript
export default function web(ctx) {
  ctx.addLanguage("node", { version: "22", packageManager: "npm" });
  ctx.addTool("curl");
  ctx.addProcess({
    name: "web",
    command: ["npm", "run", "dev"],
    port: 3000,
    healthCheck: { type: "http", url: "http://localhost:3000/health" },
  });
}
```

## Languages, packages, and tools

`addLanguage(name, { version, packageManager })` selects the runtime and derives
dependency installation from project manifests. `addPackage(manager, name,
{ version })` adds tooling through a package manager. `addTool(name, options?)`
adds a supported tool or system package. Declare only what you need: image
generation and dependency layers stay Biodome's responsibility.

```javascript
export default function backend(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addPackage("pip", "pytest");
  ctx.addTool("libpq-dev");
}
```

## Services

```javascript
// .biodome/services.mjs
export default function services(ctx) {
  ctx.addService("postgres", {
    databases: [{ name: "app" }],
    users: [{ name: "app", password: { env: "DATABASE_PASSWORD" } }],
    extensions: ["pgcrypto", "pg_trgm"],
  });
  ctx.addService("redis");
}
```

Postgres and Redis run as supervised processes in the environment. Database data
is ephemeral by default. Service configuration derives initialization and
connection information; `biodome info` describes the environment.

## Processes, lifecycle hooks, and actions

`addProcess()` runs a daemon; `addHook()` runs a command at a lifecycle point.
Both accept argv commands, scoped environment variables, and a working directory.
Health checks support HTTP, TCP, and command probes.

```javascript
export default function seed(ctx) {
  ctx.addHook({
    name: "seed",
    command: ["node", "scripts/seed.mjs"],
    startOn: "start.pre",
    intent: "Prepare test accounts",
    input: { fixture: "checkout" },
    outputs: ["results/seed.json"],
  });
}
```

For an on-demand command, use `addAction()` in `.biodome/actions/`. See
[actions](actions.md) for input/output delivery and QA/performance examples.

## Repositories

```javascript
ctx.addRepo({
  name: "backend",
  url: "https://github.com/acme/backend.git",
  branch: "feature/checkout",
  path: "repos/backend",
  credentials: { token: { env: "GITHUB_TOKEN" } },
});
```

Repository sync runs during environment startup. Tokens stay out of clone URLs;
SSH credentials require an environment-backed key and pinned `knownHosts`.
For the current repository's branch, use a Git worktree as described in
[branch sessions](actions.md#work-on-a-branch-without-changing-your-checkout).

## Environment, endpoints, and storage

- `addEnv(key, { value })` declares non-secret configuration.
- `addEnv(key, { from: { env }, required })` injects runtime credentials.
- `addEndpoint({ name, url, port, description, metadata })` describes how to reach
  an application or service.
- `addVolume()` and convenience methods provide local/cloud storage where the
  target supports it. Proxy access needs MCP; direct cloud/FUSE mounts require
  explicit unsafe opt-in. ECS does not support mounted volumes.
- `addProvider()` and service-specific helpers describe optional external
  connections, not LLM/model configuration.

See the [API](api.md) for credential types and [apps](apps.md) for composing
multiple applications. Configuration is trusted host-side JavaScript, not a
security sandbox.
