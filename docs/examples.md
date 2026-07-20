# Examples

## Django + Postgres + Redis

```javascript
// .biodome/services.mjs
export default function services(ctx) {
  ctx.addService("postgres", {
    port: 5432,
    databases: [{ name: "myapp" }],
    users: [{ name: "myapp", password: "devpassword" }],
  });

  ctx.addService("redis", { port: 6379 });
}
```

```javascript
// .biodome/features/python.mjs
export default function python(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addPackage("pip", "django", { version: "5.0" });
  ctx.addPackage("pip", "psycopg");
  ctx.addPackage("pip", "redis");
  ctx.addTool("libpq-dev");
}
```

```javascript
// .biodome/features/django.mjs
export default function django(ctx) {
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
}
```

```javascript
// .biodome/features/migrate.mjs
export default function migrate(ctx) {
  ctx.addHook({
    name: "migrate",
    command: ["python", "manage.py", "migrate"],
    startOn: "start.post",
  });
}
```

## Node.js monorepo with pnpm

```javascript
// .biodome/features/node.mjs
export default function node(ctx) {
  ctx.addLanguage("node", { version: "20", packageManager: "pnpm" });
}
```

```javascript
// .biodome/features/web.mjs
export default function web(ctx) {
  ctx.addProcess({
    name: "web",
    command: ["pnpm", "dev"],
    port: 3000,
    healthCheck: { type: "http", url: "http://localhost:3000" },
    workingDir: "apps/web",
  });
}
```

## Go API server

```javascript
// .biodome/features/go.mjs
export default function go(ctx) {
  ctx.addLanguage("go", { version: "1.22" });
}
```

```javascript
// .biodome/features/api.mjs
export default function api(ctx) {
  ctx.addProcess({
    name: "api",
    command: ["go", "run", "./cmd/server"],
    port: 8080,
    healthCheck: { type: "http", url: "http://localhost:8080/health" },
  });
}
```

## Rust + Postgres

```javascript
// .biodome/features/rust.mjs
export default function rust(ctx) {
  ctx.addLanguage("rust", { version: "1.75" });
}
```

```javascript
// .biodome/features/server.mjs
export default function server(ctx) {
  ctx.addProcess({
    name: "server",
    command: ["cargo", "run"],
    port: 8080,
    healthCheck: { type: "http", url: "http://localhost:8080" },
  });
}
```

## Django API + Angular frontend in one container

```javascript
// .biodome/services.mjs
export default function services(ctx) {
  ctx.addService("postgres", {
    port: 5432,
    databases: [{ name: "myapp" }],
    users: [{ name: "myapp", password: "devpassword" }],
  });
}
```

```javascript
// .biodome/features/python.mjs
export default function python(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addPackage("pip", "django", { version: "5.0" });
  ctx.addPackage("pip", "psycopg");
}
```

```javascript
// .biodome/features/node.mjs
export default function node(ctx) {
  ctx.addLanguage("node", { version: "20" });
}
```

```javascript
// .biodome/features/app.mjs
export default function app(ctx) {
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

  ctx.addProcess({
    name: "angular",
    command: ["npm", "run", "start", "--", "--host", "0.0.0.0", "--port", "4200"],
    port: 4200,
    workingDir: "frontend",
    healthCheck: { type: "http", url: "http://localhost:4200" },
  });
}
```

Because both `python` and `node` are declared, the generated image uses `debian:12-slim` as its base and installs both runtimes. Both processes run under `supervisord` in the same container.

## Laravel + Postgres

```javascript
// .biodome/services.mjs
export default function services(ctx) {
  ctx.addService("postgres", {
    port: 5432,
    databases: [{ name: "laravel" }],
    users: [{ name: "laravel", password: "devpassword" }],
  });
}
```

```javascript
// .biodome/features/php.mjs
export default function php(ctx) {
  ctx.addLanguage("php", { version: "8.3" });
}
```

```javascript
// .biodome/features/app.mjs
export default function app(ctx) {
  ctx.addProcess({
    name: "laravel",
    command: ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"],
    port: 8000,
    healthCheck: {
      type: "http",
      url: "http://localhost:8000",
      interval: "5s",
      timeout: "3s",
      retries: 10,
    },
  });
}
```

```javascript
// .biodome/features/migrate.mjs
export default function migrate(ctx) {
  ctx.addHook({
    name: "migrate",
    command: ["php", "artisan", "migrate", "--force"],
    startOn: "start.post",
  });
}
```

Composer dependencies are installed from `composer.json`/`composer.lock`, and the generated `vendor` directory is persisted in a Docker volume so iterative rebuilds stay fast.

## Custom MCP server

```javascript
// .biodome/features/opencode-mcp.mjs
export default function opencodeMcp(ctx) {
  ctx.addProcess({
    name: "opencode-mcp",
    command: ["node", "mcp-server.js"],
    port: 3001,
    healthCheck: { type: "http", url: "http://localhost:3001/health" },
  });
}
```

## Conditional setup based on files

```javascript
// .biodome/features/setup.mjs
export default function setup(ctx) {
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
}
```

## Branch-based environment

```javascript
// .biodome/features/env.mjs
export default function branchEnv(ctx) {
  const result = ctx.exec("git branch --show-current");
  const branch = result.stdout.trim();

  ctx.addEnv("BRANCH", { value: branch });

  if (branch === "main") {
    ctx.addEnv("DEBUG", { value: "0" });
  } else {
    ctx.addEnv("DEBUG", { value: "1" });
  }
}
```

## Multi-process project

```javascript
// .biodome/features/app.mjs
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

  ctx.addProcess({
    name: "worker",
    command: ["python", "manage.py", "runworker"],
  });
}
```

`supervisord` manages all three processes in the same dev container.

## Local + cloud volumes

```javascript
// .biodome/features/volumes.mjs
export default function volumes(ctx) {
  ctx.addVolume({
    name: "data",
    type: "local",
    source: "./data",
    target: "/workspace/data",
  });

  ctx.addVolume({
    name: "s3-assets",
    type: "s3",
    bucket: "my-project-assets",
    prefix: "dev/",
    target: "/workspace/assets",
    credentials: {
      accessKeyId: { env: "AWS_ACCESS_KEY_ID" },
      secretAccessKey: { env: "AWS_SECRET_ACCESS_KEY" },
    },
  });
}
```

Local volumes become Docker Compose bind mounts. S3, Dropbox, and Google Drive volumes are mounted with `rclone` inside the dev container.
