# Dev Containers: What's Missing for a Platform-Agnostic Sandbox

## The Case for Dev Containers

Dev Containers is the closest existing standard to what we're building. It has:
- A **declarative config format** (`devcontainer.json`)
- **Container-based isolation** (Docker)
- **A feature system** for composable tooling
- **Lifecycle scripts** (`postCreateCommand`, `postStartCommand`)
- **IDE integration** (VS Code, JetBrains, GitHub Codespaces)
- **Port forwarding** (`forwardPorts`, `portsAttributes`)
- **Multi-service support** (via Docker Compose)

It's the industry standard with the largest ecosystem. But it has specific gaps that prevent it from being the platform-agnostic sandbox manager we need.

---

## Gap 1: Docker-Only Runtime (The Biggest Gap)

Dev Containers **only supports Docker**. There is no abstraction layer. The spec defines `image`, `dockerFile`, and `dockerComposeFile` -- all Docker-specific primitives.

| Runtime | Dev Containers | Our Tool |
|---------|---------------|----------|
| Local Docker | Yes | Yes |
| Fly.io (Firecracker) | No | Planned |
| Modal (gVisor) | No | Planned |
| Kubernetes | No (envbuilder exists, not spec) | Planned |
| Remote SSH | No | Planned |
| Codespaces | Yes (Docker under the hood) | Via provider plugin |

The spec itself hardcodes Docker concepts at every level:
- `build.dockerfile` -- assumes a Dockerfile
- `runArgs` -- passes raw Docker CLI flags
- `containerEnv`, `remoteEnv` -- environment for Docker containers
- `mounts` -- Docker volume mounts

If you want to run on Kubernetes, you need third-party tools like Coder's envbuilder or DevPod, which translate devcontainer.json into Kubernetes primitives. There's no native path.

**Source**: Dev Container spec (https://github.com/devcontainers/spec), Coder envbuilder (https://github.com/coder/envbuilder)

---

## Gap 2: No Service Type System

Dev Containers has no concept of service types. Services are handled entirely through Docker Compose -- raw YAML with no validation, no typed config, no auto-generated connection info.

```json
// devcontainer.json -- only references a compose file
{
  "dockerComposeFile": "../docker-compose.yml",
  "service": "app",
  "runServices": ["db", "redis"]
}
```

```yaml
# docker-compose.yml -- raw YAML, no type safety
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: devpassword
      POSTGRES_DB: myapp
    # No validation of databases, users, extensions
```

Compare with our typed approach:
```yaml
services:
  postgres:
    version: "16"
    databases:
      - name: myapp
        owner: app
    users:
      - name: app
        password: devpassword
```

The Dev Containers approach means:
- Every project reinvents the same PostgreSQL config
- No auto-generated `DATABASE_URL` or `.env` file
- Connection details must be manually documented
- No validation of service configuration

**Source**: Dev Container multi-service docs (https://code.visualstudio.com/docs/devcontainers/compose)

---

## Gap 3: No Auto-Generated Environment Context

Dev Containers provides `remoteEnv` and `containerEnv` for manually setting environment variables. It does **not** auto-generate anything:

| What's Missing | Dev Containers | Our Tool |
|---------------|---------------|----------|
| `DATABASE_URL` | Must be hand-written | Auto-generated from service config |
| `AGENTS.md` with connection info | Not generated | Auto-generated |
| `.env` file from config | Not generated | Auto-generated |
| Connection strings for AI agents | Not generated | Auto-generated |

The same information must be manually duplicated across `docker-compose.yml`, `devcontainer.json`, `README.md`, and `AGENTS.md`. This means they inevitably drift.

```json
// devcontainer.json -- you must manually set every env var
{
  "remoteEnv": {
    "DATABASE_URL": "postgresql://app:devpassword@db:5432/myapp",
    "REDIS_URL": "redis://redis:6379"
  }
}
```

If someone changes the database password in `docker-compose.yml`, the `remoteEnv` in `devcontainer.json` and the `README.md` both need manual updates. Our tool generates all of these from the single `sandbox.yaml`.

---

## Gap 4: No AI Agent Integration

Dev Containers was designed for human developers using IDEs. It has no concept of AI coding agents:

| Integration | Dev Containers | Our Tool |
|-------------|---------------|----------|
| AGENTS.md/CLAUDE.md generation | No | Auto-generated with connection strings |
| OpenCode MCP server | No | Built-in MCP server for agent querying |
| Pi extension package | No | Built-in extension for sandbox lifecycle |
| Context injection | No | Auto-env for agents |

An AI agent opening a Dev Container has no way to programmatically discover:
- What services are running and how to connect
- What ports are available
- What credentials to use
- What scripts are available to run

It relies entirely on what's in the codebase (README, Makefile) -- the same fragile setup Dev Containers was supposed to eliminate for humans.

---

## Gap 5: Image Rebuilds Are Slow

Dev Containers uses Docker images. Dependency changes require a full image rebuild:

| Scenario | Dev Containers | Our Tool |
|----------|---------------|----------|
| Change Dockerfile | 2-5 min rebuild | Config change triggers prebuild in CI |
| Change package.json | npm install in container (fast) | Prebuilt image with deps cached |
| Add a package | Update Dockerfile + rebuild | Add line to sandbox.yaml |
| First setup on new machine | Pull + build (5-10 min) | Pull prebuilt image (seconds) |

From the DevToolReviews comparison:
> "Rebuilding after a dependency change reveals Dev Containers' biggest weakness: changing a Dockerfile often requires rebuilding the entire image, which can take several minutes even with layer caching."

Dev Containers does not have a prebuilt-image workflow baked in. You can manually prebuild images and push to a registry, but this is a team discipline, not a tool feature.

**Source**: DevToolReviews (https://www.devtoolreviews.com/reviews/devbox-vs-dev-containers-vs-nix-2026)

---

## Gap 6: Docker Overhead on macOS and Windows

Dev Containers runs inside a Linux VM on macOS and Windows. This has real costs:

- **RAM overhead**: 1.5-2 GB just for the Docker VM
- **Filesystem performance**: Bind mounts through the VM are 10-50x slower than native
  - Angular build: 8s native vs 45s in WSL2 bind mount
  - npm install: noticeably slower
- **CPU overhead**: All system calls go through the VM boundary
- **Disk usage**: ~1.2 GB per typical dev container image

As one user reported:
> "Apps being generally slow or timing out. This is unfortunately a deal breaker. Most of the time I am waiting. CPU fan spins in high mode all the time."

Our tool's approach of prebuilt images minimizes rebuild time, but the runtime overhead is a fundamental Docker limitation. Our provider abstraction allows opting into native runtimes (Fly.io, Modal, remote) where appropriate.

**Source**: WSL2 performance issues (https://levelup.gitconnected.com/codespaces-vs-dev-containers-running-net-10-and-angular-21-in-vs-code-e414783bc919)

---

## Gap 7: Feature System Has Known Limitations

Dev Container Features are a great idea, but they have real bugs in practice:

- **Multi-service feature bug**: When using Docker Compose with multiple services, only the first service gets features installed. The second service is missing all features. This is a confirmed spec limitation -- "Only a single devcontainer.json is considered at a time."
- **No dependency resolution**: Features have `dependsOn` and `installsAfter` but there's no real dependency graph with conflict resolution.
- **No caching**: Features are re-installed on every container create. There's no prebuilt feature layer.
- **No version pinning by default**: Most teams use `:latest` for features, which causes drift.

Our tool avoids this by using a **namespaced package system** (`apt:`, `npm:`, `pip:`) that generates a proper Dockerfile with layer caching. No runtime feature installation, no multi-service bugs.

**Source**: Dev Containers GitHub issues #1211, #546 (https://github.com/devcontainers/cli/issues/1211, https://github.com/devcontainers/spec/issues/546)

---

## Gap 8: No Lifecycle Management Beyond Container Start

Dev Containers has three lifecycle hooks:
- `onCreateCommand` -- runs once when container is created
- `postCreateCommand` -- runs after container is created
- `postStartCommand` -- runs every time the container starts

There's no:
- `preStop` -- to save state or gracefully shut down
- `file.changed` -- to trigger linting or tests on file changes
- `session.idle` -- to auto-stop to save resources
- `preBuild`/`postBuild` -- image build hooks
- `exec.pre`/`exec.post` -- command execution hooks

Our tool's lifecycle system covers the full sandbox lifecycle, not just container startup.

**Source**: Dev Container lifecycle scripts (https://containers.dev/implementors/json_reference/)

---

## Gap 9: No Provider/Platform Abstraction

Dev Containers has no plugin or provider system for adding new backends. The spec is:
- Defined by Microsoft
- Implemented by VS Code, JetBrains, and the CLI
- Extended through Features (OCI artifacts) and lifecycles (scripts)

There's no way to write a "Dev Containers provider for Fly.io" or "Dev Containers provider for Modal." The closest alternatives are:
- **DevPod**: Translates devcontainer.json to multiple backends (external tool, not part of spec)
- **Coder envbuilder**: Builds dev container images for Kubernetes (external tool, not part of spec)

Both are third-party workarounds, not core capabilities.

Our tool is designed with provider abstraction from day one.

---

## Gap 10: IDE-Centric by Design

Dev Containers was designed for VS Code. Everything flows from that:

| Feature | VS Code | JetBrains | Terminal-only |
|---------|---------|-----------|---------------|
| Full support | Yes | Plugin (good but not identical) | CLI only |
| Feature installation | Automatic | Manual | `devcontainer up` |
| Port forwarding | Automatic | Manual | Manual |
| Extension sync | Built-in | Plugin-dependent | N/A |
| Dev experience | Excellent | Good | Basic |

For AI coding agents that work in a terminal (Pi, OpenCode), the Dev Containers experience is:
1. Build the container
2. Start it with `devcontainer up`
3. `docker exec` or `devcontainer exec` into it

It works, but the agent gets none of the benefits -- no auto-generated context, no service discovery, no MCP tools.

Our tool is CLI-first with IDE as optional output. It can generate `devcontainer.json` from `sandbox.yaml` when you want IDE integration, but the primary interface is terminal-native.

**Source**: Dev Containers JetBrains support (https://www.jetbrains.com/help/idea/connect-to-devcontainer.html)

---

## Summary: Where Dev Containers Falls Short

| Capability | Dev Containers | Our Tool |
|-----------|---------------|----------|
| **Config format** | `devcontainer.json` (JSONC) | `sandbox.yaml` (YAML) |
| **Runtime** | Docker only | Docker + providers (Fly, Modal, K8s, SSH) |
| **Service definitions** | Raw Docker Compose YAML | Typed service types (postgres, redis, etc.) |
| **Auto-generated env vars** | Manual everywhere | Auto-generated from config |
| **AI agent context** | None | AGENTS.md, MCP server, Pi extension |
| **Lifecycle hooks** | 3 hooks (onCreate, postCreate, postStart) | Full lifecycle (pre/post build, start, stop, exec, file) |
| **Image builds** | Manual rebuild (2-5 min) | Config-change-triggered prebuild in CI |
| **Package system** | Features (OCI artifacts, runtime install) | Namespaced packages (apt/npm/pip) + Docker layers |
| **Provider abstraction** | None | Plugin interface for any backend |
| **IDE integration** | Excellent (VS Code) | CLI-first, generates devcontainer.json |
| **macOS performance** | VM overhead (1.5-2 GB RAM) | Depends on provider; native on Fly/Modal |
| **Reproducibility** | Tag-dependent (floating tags = drift) | Lock file + pinned digests |

## The Hybrid Path

The smartest approach isn't to compete with Dev Containers -- it's to **be a superset**. Our `sandbox.yaml` can **generate** `devcontainer.json` + `Dockerfile` + `docker-compose.yml` as an output format. Users who want VS Code integration get it. Users who want AI agent integration get that too. Same config, different outputs.

```
sandbox.yaml
    |
    ├──> Dockerfile + docker-compose.yml  (for local Docker)
    ├──> devcontainer.json                (for VS Code / Codespaces)
    ├──> AGENTS.md                        (for Pi / OpenCode context)
    ├──> fly.toml                         (for Fly.io deployment)
    ├──> modal.py config                  (for Modal)
    └──> .env                             (auto-generated env vars)
```
