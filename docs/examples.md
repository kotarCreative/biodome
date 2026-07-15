# Examples

## Django + Postgres + Redis

```javascript
// sandbox/services.js
const ctx = sandbox.ctx();

ctx.addService("postgres", {
  port: 5432,
  databases: [{ name: "myapp" }],
  users: [{ name: "myapp", password: "devpassword" }],
});

ctx.addService("redis", { port: 6379 });
```

```javascript
// sandbox/features/python.js
const ctx = sandbox.ctx();

ctx.addLanguage("python", { version: "3.12" });
ctx.addPackage("pip", "django", { version: "5.0" });
ctx.addPackage("pip", "psycopg");
ctx.addPackage("pip", "redis");
ctx.addTool("libpq-dev");
```

```javascript
// sandbox/features/django.js
const ctx = sandbox.ctx();

ctx.addProcess({
  name: "django",
  command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
  port: 8000,
  healthCheck: {
    type: "http",
    url: "http://localhost:8000/admin/login/",
    interval: "5s",
    retries: 10,
  },
  environment: { DEBUG: "1" },
});
```

```javascript
// sandbox/features/migrate.js
const ctx = sandbox.ctx();

ctx.addHook({
  name: "migrate",
  command: ["python", "manage.py", "migrate"],
  startOn: "start.post",
});
```

## Node.js monorepo with pnpm

```javascript
// sandbox/features/node.js
const ctx = sandbox.ctx();

ctx.addLanguage("node", { version: "20", packageManager: "pnpm" });
```

```javascript
// sandbox/features/web.js
const ctx = sandbox.ctx();

ctx.addProcess({
  name: "web",
  command: ["pnpm", "dev"],
  port: 3000,
  healthCheck: { type: "http", url: "http://localhost:3000" },
  workingDir: "apps/web",
});
```

## Go API server

```javascript
// sandbox/features/go.js
const ctx = sandbox.ctx();

ctx.addLanguage("go", { version: "1.22" });
```

```javascript
// sandbox/features/api.js
const ctx = sandbox.ctx();

ctx.addProcess({
  name: "api",
  command: ["go", "run", "./cmd/server"],
  port: 8080,
  healthCheck: { type: "http", url: "http://localhost:8080/health" },
});
```

## Rust + Postgres

```javascript
// sandbox/features/rust.js
const ctx = sandbox.ctx();

ctx.addLanguage("rust", { version: "1.75" });
```

```javascript
// sandbox/features/server.js
const ctx = sandbox.ctx();

ctx.addProcess({
  name: "server",
  command: ["cargo", "run"],
  port: 8080,
  healthCheck: { type: "http", url: "http://localhost:8080" },
});
```

## Custom MCP server

```javascript
// sandbox/features/opencode-mcp.js
const ctx = sandbox.ctx();

ctx.addProcess({
  name: "opencode-mcp",
  command: ["node", "mcp-server.js"],
  port: 3001,
  healthCheck: { type: "http", url: "http://localhost:3001/health" },
});
```

## Conditional setup based on files

```javascript
// sandbox/features/setup.js
const ctx = sandbox.ctx();

if (ctx.fileExists("pyproject.toml")) {
  ctx.addLanguage("python", { version: "3.12", packageManager: "poetry" });
} else if (ctx.fileExists("requirements.txt")) {
  ctx.addLanguage("python", { version: "3.12" });
}

if (ctx.fileExists("package.json")) {
  const pkg = ctx.readJSON("package.json");
  if (pkg?.dependencies?.next) {
    ctx.addTool("vercel");
  }
}
```

## Branch-based environment

```javascript
// sandbox/features/env.js
const ctx = sandbox.ctx();

const result = ctx.exec("git branch --show-current");
const branch = result.stdout.trim();

ctx.setEnv("BRANCH", branch);

if (branch === "main") {
  ctx.setEnv("DEBUG", "0");
} else {
  ctx.setEnv("DEBUG", "1");
}
```

## Multi-process project

```javascript
// sandbox/features/app.js
const ctx = sandbox.ctx();

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

ctx.addProcess({
  name: "worker",
  command: ["python", "manage.py", "runworker"],
});
```

`supervisord` manages all three processes in the same dev container.
