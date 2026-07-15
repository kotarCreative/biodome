# Package & Service Interface Design

## Overview

This document defines how the sandbox manager should expose a simple API for declaring packages (runtimes, CLIs, libraries) and services (databases, caches, message brokers) via a filesystem-first config structure. The design draws from Eve's filesystem-first agent framework, Devbox, devenv, devcontainer.json, and Docker Compose patterns.

---

## 1. Design Principles

1. **Declarative, not imperative** -- users describe *what* they need, not *how* to install it.
2. **Simple defaults, powerful overrides** -- a one-line include for common stacks; full control for advanced users.
3. **Self-documenting** -- the config generates `AGENTS.md`/`CLAUDE.md` with connection strings, ports, and credentials.
4. **Portable** -- same config works locally (Docker), in the cloud (Fly.io, Modal), and in CI.
5. **Lockable** -- a lock file pins exact versions for reproducibility.
6. **Composable** -- monorepo support via `include`/`import` directives.
7. **Filesystem-first** -- config is split across a handful of files under a `sandbox/` directory, grouped by concern; the CLI discovers and compiles them at build time.

---

## 2. Config Structure (sandbox/ Directory)

Configuration is filesystem-first. Each concern lives in its own file under a `sandbox/` directory in the project root. The CLI discovers and compiles them at build time — no central registry to maintain.

```
sandbox/                          # Auto-discovered config directory
  config.yaml                     # Project metadata + feature flags
  env.yaml                        # Languages, packages, tools, env vars
  services.yaml                   # Service definitions (postgres, redis, etc.)
  hooks.yaml                      # Lifecycle hooks
  secrets.yaml                    # Secret references
```

### 2.1 Project Config: `sandbox/config.yaml`

```yaml
name: my-project
description: A Node.js + PostgreSQL API
version: 1

# Use a prebuilt image instead of building from packages
# image: ghcr.io/myorg/dev-env:latest

# Build caching: pushes Docker layer cache to a registry so rebuilds
# are fast on any machine. Requires docker login to the registry.
build:
  cache:
    registry: ghcr.io/myorg/cache
    mode: max             # "max" caches all layers, "min" caches only final

# Idle management: auto-stops the sandbox after inactivity to
# free resources. The sandbox can be started again with `sandbox up`.
idle:
  timeout: 30m            # duration like 30m, 1h, 2h
  action: stop            # stop, snapshot, or hibernate
```

### 2.2 Environment: `sandbox/env.yaml`

Languages, packages, tools, and environment variables all shape the dev environment — they live together.

```yaml
languages:
  node:
    version: "20"
    package_manager: pnpm
  python:
    version: "3.12"
    package_manager: poetry

packages:
  apt:
    - curl
    - git
    - jq
    - postgresql-client
    - redis-tools
  nix:
    - ripgrep
    - fd
  pip:
    - pytest
    - black
  npm:
    - typescript
    - vite

tools:
  gh: latest
  aws-cli: "2"
  terraform: "1.7"

env:
  NODE_ENV: development
  LOG_LEVEL: debug
```

### 2.3 Services: `sandbox/services.yaml`

```yaml
postgres:
  image: postgres:16-alpine
  version: "16"
  port: 5432
  databases:
    - name: myapp
  users:
    - name: app
      password: devpassword
  extensions:
    - postgis
    - pgvector
  init_sql: |
    CREATE TABLE IF NOT EXISTS migrations (id SERIAL PRIMARY KEY);
  exposed: true

redis:
  image: redis:7-alpine
  version: "7"
  port: 6379
  password: null
  exposed: true

mongodb:
  image: mongo:7
  version: "7"
  port: 27017
  root_user: admin
  root_password: devpassword
  databases:
    - name: myapp
  exposed: true
```

### 2.4 Hooks: `sandbox/hooks.yaml`

```yaml
start:
  post:
    - command: ./scripts/run-migrations.sh
    - command: npx prisma db push
    - inline: |
        echo "Dev environment ready!"
        echo "API: http://localhost:3000"
        echo "DB: postgresql://app:devpassword@localhost:5432/myapp"
```

### 2.5 Secrets: `sandbox/secrets.yaml`

```yaml
git_ssh_key: "${LOCAL_SSH_AGENT}"
docker_config: "${LOCAL_DOCKER_CONFIG}"
```

---

## 3. Packages: The Simple String+Version Format

Packages are declared inside `sandbox/env.yaml` under the `packages:` key. The simplest way is by name with optional version:

```yaml
# sandbox/env.yaml
packages:
  apt:
    - curl
    - git@2.40     # version pinning
```

Each package manager namespace resolves to a different installation mechanism:

| Namespace | Mechanism | Example |
|-----------|-----------|---------|
| `apt:` | System package (Debian/Ubuntu) | `build-essential` |
| `npm:` | Node.js package | `typescript@5.4` |
| `pip:` | Python package | `pytest@8.0` |
| `nix:` | Nix package (any) | `ripgrep@latest` |
| `cargo:` | Rust crate | `bat` |
| `go:` | Go module | `golang.org/x/tools` |
| `gem:` | Ruby gem | `rails@7.1` |

### Package Object Form (for advanced options)

```yaml
# sandbox/env.yaml
packages:
  apt:
    - name: python3
      version: "3.12"
      arch: [amd64, arm64]
  npm:
    - name: typescript
      version: "5.4"
      global: true
  pip:
    - name: torch
      version: "2.2"
      index_url: https://download.pytorch.org/whl/cu121
```

---

## 4. Languages: High-Level Runtime Abstractions

Languages are declared inside `sandbox/env.yaml` under the `languages:` key. Each language is a named entry — the key is the language name, and the value is its configuration.

Languages are a higher-level abstraction over packages. They handle:
- Installing the correct runtime version
- Setting up the package manager
- Configuring environment variables
- Installing common tooling (linters, formatters, debuggers)

### Full example

```yaml
# sandbox/env.yaml
languages:
  node:
    version: "20"
    package_manager: pnpm
    install_deps: true
    global_packages:
      - typescript
      - vite
    env:
      NODE_OPTIONS: --max-old-space-size=4096

  python:
    version: "3.12"
    package_manager: poetry
    install_deps: true
    poetry:
      install: true
      create_venv: true
      config:
        virtualenvs.in-project: true

  go:
    version: "1.22"
    cgo_enabled: false
    build_cache: true

  rust:
    version: "1.77"
    components: [clippy, rustfmt]
    targets: [wasm32-unknown-unknown]

  java:
    version: "21"
    build_tool: gradle
    gradle_version: "8.6"
```

### Common fields (available in every language)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | string | latest stable | Runtime version (`"20"`, `"lts"`, `"3.12"`) |
| `install_deps` | bool | `false` | Auto-install project dependencies on build |
| `env` | map | `{}` | Extra environment variables for this runtime |
| `global_packages` | string[] | `[]` | Packages to install globally (language-specific) |

### Per-language extras

| Language | Extra fields |
|----------|-------------|
| Node | `package_manager` (`npm`, `yarn`, `pnpm`) |
| Python | `package_manager` (`pip`, `poetry`, `uv`, `pipenv`); `poetry.*` sub-config |
| Go | `cgo_enabled` (bool); `build_cache` (bool) |
| Rust | `components` (rustup); `targets` (cross-compile) |
| Java | `build_tool` (`maven`, `gradle`); `gradle_version` |

---

## 5. Services: Infrastructure Dependencies

Services are pre-configured Docker containers that the sandbox manager starts alongside the dev container. All services are declared in `sandbox/services.yaml`. Each key under the top level is a service name, and its value is the configuration.

They are the most complex part of the schema because each service type has unique configuration options.

### PostgreSQL

```yaml
# sandbox/services.yaml (partial)
postgres:
  image: postgres:16-alpine       # defaults to postgres:{version}-alpine
  version: "16"
  port: 5432
  host: localhost
  databases:
    - name: myapp
      owner: app
      extensions: [postgis]
      init_sql: CREATE EXTENSION IF NOT EXISTS postgis;
  users:
    - name: app
      password: devpassword
      privileges: ALL PRIVILEGES ON DATABASE myapp
  root_user: postgres
  root_password: rootpassword
  settings:
    shared_buffers: 256MB
    max_connections: 100
  init_script: ./scripts/init-db.sql
  data_volume: postgres_data      # named volume for persistence
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U app -d myapp"]
    interval: 2s
    timeout: 5s
    retries: 10
    start_period: 10s
  exposed: true                  # expose port to host
  resources:
    memory: 512MB
    cpu: 0.5
```

**Auto-generated environment variables:**
```bash
DATABASE_URL=postgresql://app:devpassword@localhost:5432/myapp
PGHOST=localhost
PGPORT=5432
PGUSER=app
PGPASSWORD=devpassword
PGDATABASE=myapp
```

**Connection info printed on start:**
```
PostgreSQL:
  Internal: postgres://app:devpassword@postgres:5432/myapp
  External: postgresql://app:devpassword@localhost:5432/myapp
  CLI: psql -h localhost -U app -d myapp
  Admin UI: http://localhost:8080 (pgweb, optional)
```

### MongoDB

```yaml
# sandbox/services.yaml (partial)
mongodb:
  image: mongo:7
  version: "7"
  port: 27017
  root_user: admin
  root_password: devpassword
  databases:
    - name: myapp
      collections:
        - users
        - posts
  init_script: ./scripts/init-mongo.js
  data_volume: mongo_data
  exposed: true
```

**Auto-generated environment variables:**
```bash
MONGODB_URL=mongodb://admin:devpassword@localhost:27017/myapp
MONGODB_URI=mongodb://admin:devpassword@localhost:27017/myapp?authSource=admin
```

**Connection info:**
```
MongoDB:
  Internal: mongodb://admin:devpassword@mongodb:27017/myapp?authSource=admin
  External: mongodb://admin:devpassword@localhost:27017/myapp
  CLI: mongosh -u admin -p devpassword --authenticationDatabase admin localhost:27017/myapp
  Admin UI: http://localhost:8081 (mongo-express, optional)
```

### Redis

```yaml
# sandbox/services.yaml (partial)
redis:
  image: redis:7-alpine
  version: "7"
  port: 6379
  password: devpassword         # omit or set to null for no auth
    settings:
      maxmemory: 512mb
      maxmemory-policy: allkeys-lru
      appendonly: yes
    data_volume: redis_data
    exposed: true
```

**Auto-generated environment variables:**
```bash
REDIS_URL=redis://:devpassword@localhost:6379/0
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=devpassword
```

### MySQL

```yaml
# sandbox/services.yaml (partial)
mysql:
  image: mysql:8.0
  version: "8.0"
  port: 3306
  root_password: devpassword
  databases:
    - name: myapp
  users:
    - name: app
      password: devpassword
  settings:
    character-set-server: utf8mb4
    collation-server: utf8mb4_unicode_ci
  init_script: ./scripts/init-mysql.sql
```

### RabbitMQ (Message Broker)

```yaml
# sandbox/services.yaml (partial)
rabbitmq:
  image: rabbitmq:3-management-alpine
  version: "3"
  ports:
    amqp: 5672
    management: 15672
  users:
    - name: app
      password: devpassword
      tags: administrator
  virtual_hosts:
    - myapp
```

### MinIO (S3-compatible Storage)

```yaml
# sandbox/services.yaml (partial)
minio:
  image: minio/minio
  ports:
    api: 9000
    console: 9001
  root_user: minioadmin
  root_password: minioadmin
  buckets:
    - myapp-uploads
    - myapp-assets
```

---

## 6. React Native Support

React Native (with Expo) requires special handling because it needs:
- Node.js + watchman for file watching
- Port 8081 for the Metro bundler
- Network access for the Expo Go app on a phone
- ADB forwarding for Android device connections

These files under `sandbox/` configure a React Native (Expo) sandbox:

**`sandbox/env.yaml`**:
```yaml
languages:
  node:
    version: "20"
    package_manager: npm
    install_deps: true
  java:
    version: "17"              # required for Android builds

packages:
  apt:
    - watchman                 # file watcher for Metro bundler
    - adb                      # Android Debug Bridge
  npm:
    - expo-cli
    - eas-cli

tools:
  expo: latest
  eas: latest

env:
  REACT_NATIVE_PACKAGER_HOSTNAME: "${HOST_IP}"    # set automatically
```

**`sandbox/hooks.yaml`**:
```yaml
pre-start:
  - command: adb start-server    # ensure ADB is running
```

**Note**: For Android emulator access, the dev container needs `--network=host` or special ADB forwarding setup.

### React Native Architecture Considerations

For React Native in a Docker sandbox:

1. **Metro bundler on port 8081** -- must be exposed to the host
2. **Watchman** -- needs `inotify` limits bumped in the container
3. **Expo Go** -- needs `REACT_NATIVE_PACKAGER_HOSTNAME` set to the host's LAN IP
4. **Android builds** -- require JDK 17+, Android SDK, Gradle
5. **ADB forwarding** -- for connecting to physical devices / emulators on the host

The sandbox manager should auto-detect React Native projects (presence of `app.json`, `expo` in `package.json`) and prompt for the host IP:

```yaml
# auto-generated by `sandbox init` for RN projects
env:
  REACT_NATIVE_PACKAGER_HOSTNAME: "{auto-detect-lan-ip}"
```

**Source**: Various devcontainer RN templates (https://github.com/matsu3m/react-native-expo-devcontainer-template, https://dev.to/animusna/dev-container-for-react-native-with-expo-f7j)

---

## 7. Tools: Purpose-Built CLI Abstractions

Tools are well-known CLI programs that need specific install logic. They are declared inside `sandbox/env.yaml` under the `tools:` key:

```yaml
# sandbox/env.yaml
tools:
  gh: latest                     # GitHub CLI
  aws-cli: "2"                   # AWS CLI v2
  docker: true                   # enables Docker-in-Docker
  psql: "16"                     # PostgreSQL client
  kubectl: "1.29"
  helm: "3.14"
  terraform: "1.7"
  vercel: latest
  wrangler: latest               # Cloudflare Workers CLI
```

Each tool maps to a known install recipe (internal mapping, not user-facing):

```yaml
tool_recipes:
  gh:
    apt: gh
    nix: github-cli
    verify: gh --version
  aws-cli:
    apt: awscli
    pip: awscli
    nix: awscli2
    verify: aws --version
  docker:
    apt: docker.io
    script: |-
      curl -fsSL https://get.docker.com | sh
    verify: docker --version
```

---

## 8. Generated Outputs

### 8.1 Auto-generated Dockerfile

From the config, the sandbox manager generates an optimized Dockerfile:

```dockerfile
# Auto-generated by sandbox-manager v1.0
# Source: sandbox/ directory

FROM node:20-slim AS base

# Install system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git jq postgresql-client redis-tools \
    && rm -rf /var/lib/apt/lists/*

# Install Python + Poetry
RUN pip install --no-cache-dir poetry

# Copy dependency manifests
COPY package.json pnpm-lock.yaml pyproject.toml poetry.lock ./

# Install dependencies (layer cached until manifests change)
RUN --mount=type=cache,target=/root/.npm \
    corepack enable && corepack prepare pnpm@latest --activate && \
    pnpm install

RUN --mount=type=cache,target=/root/.cache/pip \
    poetry install --no-root

# Copy source code
COPY . .

# Set environment variables
ENV NODE_ENV=development \
    DATABASE_URL=postgresql://app:devpassword@postgres:5432/myapp \
    REDIS_URL=redis://:devpassword@redis:6379/0

CMD ["bash"]
```

### 8.2 Auto-generated docker-compose.yaml

```yaml
# Auto-generated by sandbox-manager v1.0
version: "3.8"

services:
  dev:
    build:
      context: .
      dockerfile: .sandbox/Dockerfile
    image: sandbox-my-project:latest
    ports:
      - "3000:3000"              # app port
    volumes:
      - .:/workspace            # source code
      - node_modules:/workspace/node_modules
    environment:
      DATABASE_URL: postgresql://app:devpassword@postgres:5432/myapp
      REDIS_URL: redis://:devpassword@redis:6379/0
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    networks:
      - sandbox
    command: sleep infinity      # keep container alive

  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: devpassword
      POSTGRES_DB: myapp
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-scripts:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d myapp"]
      interval: 2s
      timeout: 5s
      retries: 10
      start_period: 10s
    networks:
      - sandbox

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --requirepass devpassword
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
    networks:
      - sandbox

volumes:
  postgres_data:
  redis_data:
  node_modules:

networks:
  sandbox:
    driver: bridge
```

### 8.3 Auto-generated AGENTS.md

```markdown
# Development Environment

Auto-generated by sandbox-manager for `my-project`.

## Languages & Tools
- Node.js 20 (pnpm)
- Python 3.12 (poetry)
- PostgreSQL 16
- Redis 7

## Available Services

### PostgreSQL
- **Internal URL**: `postgresql://app:devpassword@postgres:5432/myapp`
- **External URL**: `postgresql://app:devpassword@localhost:5432/myapp`
- **Port**: 5432

### Redis
- **Internal URL**: `redis://:devpassword@redis:6379/0`
- **External URL**: `redis://:devpassword@localhost:6379/0`
- **Port**: 6379

## Hooks
- `start.post` runs migrations automatically
- `stop.pre` backs up data

## Project Commands (run via `sandbox exec`)
- `npm run dev`
- `npm test`
- `npx prisma studio`
```

---

## 9. The Simple API: Minimal Config to Get Started

For maximum adoption, the sandbox manager should work with minimal config. The absence of any `sandbox/` directory means auto-detection from project files:

### Minimal: auto-detect everything

`sandbox init` detects `package.json` → Node.js, `pyproject.toml` → Python+Poetry, `go.mod` → Go, etc. No files needed.

### Common: just declare what's needed

**`sandbox/env.yaml`:**
```yaml
languages:
  node:
    version: "20"
```

**`sandbox/services.yaml`:**
```yaml
postgres:
  enabled: true         # defaults: version 16, port 5432
redis:
  enabled: true         # defaults: version 7, port 6379
```

### Full: complete control

**`sandbox/config.yaml`:**
```yaml
name: my-api
```

**`sandbox/env.yaml`:**
```yaml
languages:
  node:
    version: "20"
    package_manager: pnpm
  python:
    version: "3.12"
    package_manager: poetry
```

**`sandbox/services.yaml`:**
```yaml
postgres:
  version: "16"
  databases:
    - name: myapp
redis:
  version: "7"
```

### CLI Commands

```bash
# Initialize (auto-detects stack, creates sandbox/ directory)
sandbox init

# Add a package
sandbox add node@20
sandbox add postgres

# Build the image
sandbox build

# Start the environment
sandbox up

# Run a command inside
sandbox exec "npm test"

# Stop
sandbox down

# Show connection info
sandbox info

# Generate agent context files
sandbox generate agents.md
```

---

## 10. Config-to-Image Generation Pipeline

```
sandbox/ directory
    |
    v
[Discover + Parse + Validate]
    |
    |-- Resolve language versions (e.g., "lts" -> "20.11.1")
    |-- Resolve service versions (e.g., "latest" -> "16-alpine")
    |-- Resolve tool versions
    |-- Resolve package versions from lock file if present
    |
    v
[Generate Dockerfile]
    |-- base FROM image based on languages
    |-- apt packages in one RUN (with cache mount)
    |-- copy dependency manifests first
    |-- install language dependencies (npm ci, poetry install)
    |-- copy source
    |-- set env vars
    |
    v
[Generate docker-compose.yaml]
    |-- dev service with build context
    |-- service definitions for each service
    |-- health checks
    |-- volumes for persistence
    |-- environment variable wiring
    |-- network config
    |
    v
[Build Image]
    |-- docker buildx build --cache-to/--cache-from
    |-- tag as sandbox-{project-name}:latest
    |-- push to registry if configured
    |
    v
[Start Environment]
    |-- docker compose up -d
    |-- wait for health checks
    |-- run post-start hooks
    |-- print connection info
```

---

## 11. Comparison: How Existing Tools Handle This

| Aspect | Devbox (JSON) | devenv (Nix) | devcontainer.json | This Design |
|--------|--------------|--------------|-------------------|-------------|
| **Config format** | JSON (`devbox.json`) | Nix (`devenv.nix`) | JSONC (`devcontainer.json`) | Filesystem (`sandbox/` directory) |
| **Packages** | String array `["node@20"]` | Nixpkgs attributes | Features (OCI artifacts) | Namespaced: `apt:`, `npm:`, etc. |
| **Languages** | Plugin-based | `languages.python` module | Features | Built-in language modules |
| **Services** | `devbox services up` (process-compose) | `services.postgres` module | Docker Compose sidecars | First-class service definitions |
| **Ports** | N/A | `services.x.port` | `forwardPorts` array | Per-service port config + auto env vars |
| **Connection info** | Manual | Manual env vars | Manual | Auto-generated env vars + AGENTS.md |
| **Dockerfile gen** | `devbox generate dockerfile` | `devenv container` | Manual (Dockerfile + features) | Automatic from config |
| **Docker Compose gen** | Manual | Manual | References existing compose | Automatic from config |
| **Hooks** | `shell.init_hook` | `enterShell` | `postCreateCommand`, `postStartCommand` | Lifecycle hooks (pre/post build/start/stop) |
| **Env vars** | `env` object | `env` attr | `remoteEnv` | `env` + auto-generated service URLs |
| **Lock file** | `devbox.lock` | `devenv.lock` | No | `sandbox.lock` (locks all files under `sandbox/`) |
| **Include/import** | `include` | `imports` | N/A | `include` in `config.yaml` for monorepo |

---

## 12. Future: Service Templates & Plugin System

### Built-in Service Templates

```yaml
# sandbox/services.yaml
postgres: {}           # uses defaults: version 16, port 5432
redis: {}              # uses defaults: version 7, port 6379
```

### Custom Service Templates (Plugin)

```yaml
# sandbox/services.yaml
my-custom-db:
  template: postgres
  version: "16"
  databases:
    - name: customdb
  plugins:
    vector: {}
    timescaledb: {}
```

### Plugin System for Service Types

```typescript
// TypeScript plugin for a new service type
export const myServicePlugin: ServicePlugin = {
  type: "my-database",
  
  // Schema for the service's config section
  configSchema: {
    version: { type: "string", default: "latest" },
    port: { type: "number", default: 9999 },
    databases: { type: "array", items: { type: "string" } },
  },
  
  // Generate docker-compose service definition
  generateCompose(config) {
    return {
      image: `my-database:${config.version}-alpine`,
      ports: [`${config.port}:${config.port}`],
      environment: {
        MY_DB_ROOT_PASSWORD: config.rootPassword,
      },
      healthcheck: {
        test: ["CMD", "my-db-cli", "ping"],
        interval: "5s",
      },
    };
  },
  
  // Generate environment variables for the sandbox
  generateEnv(config) {
    return {
      MY_DATABASE_URL: `mydb://root:${config.rootPassword}@${config.name}:${config.port}/${config.databases[0]}`,
    };
  },
  
  // Generate connection info string
  generateConnectionInfo(config) {
    return {
      label: "My Database",
      internal: `mydb://root:${config.rootPassword}@${config.type}:${config.port}`,
      external: `mydb://root:${config.rootPassword}@localhost:${config.port}`,
    };
  },
};
```

---

## Sources

- Devbox config reference: https://www.jetify.com/docs/devbox/configuration
- Devbox Poetry template: https://www.jetify.com/devbox/templates/python-poetry
- devenv services: https://devenv.sh/services/
- devenv Postgres module: https://devenv.sh/services/postgres/
- devenv Redis module: https://devenv.sh/services/redis/
- devenv MySQL module: https://devenv.sh/services/mysql/
- DevContainer JSON reference: https://containers.dev/implementors/json_reference/
- DevContainer features: https://containers.dev/implementors/features/
- Docker Compose best practices: https://docs.docker.com/compose/
- Docker Compose health checks: https://the-practical-developer.online/posts/docker-compose-local-dev-environments/
- React Native DevContainer: https://github.com/matsu3m/react-native-expo-devcontainer-template
- React Native DevContainer guide: https://dev.to/animusna/dev-container-for-react-native-with-expo-f7j
- Devbox schema: https://catalog.lintel.tools/schemas/schemastore/devbox-config/
- devenv processes overview: https://devenv.sh/processes/
- Nix flakes for dev shells: https://blogs.pavanrangani.com/nix-reproducible-dev-environments-flakes-guide/
