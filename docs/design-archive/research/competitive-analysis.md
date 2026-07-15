# Competitive Analysis: Sandbox Manager vs Existing Tools

## How Our Proposed Tool Differs

Our sandbox manager aims to fill a specific gap: a **platform-agnostic, config-driven** tool that generates optimized Docker environments, manages services, and integrates with AI coding agents -- using a filesystem-first config structure (each concern in its own file under a `sandbox/` directory). Below is how it stacks up against each competitor.

---

## 1. vs Devbox (Jetify) -- 11,800+ stars

| Aspect | Devbox | Our Tool |
|--------|--------|----------|
| Config | JSON (`devbox.json`) | Filesystem (`sandbox/` directory) |
| Runtime | Nix (isolated shell) | Docker (container) |
| Services | Via process-compose plugin | First-class service definitions |
| AI hooks | None built-in | OpenCode MCP + Pi extension |
| Platform | Nix-powered shells | Docker + provider plugins |
| Start time | Instant (after first Nix build) | 1-5s (prebuilt image) |

### Pros vs Devbox
- **Container isolation**: Full Docker isolation vs Nix shell isolation (shared kernel)
- **Service definitions**: We have built-in postgres/mongodb/redis config; Devbox requires process-compose plugins
- **Platform portability**: Our provider model targets Docker, Fly.io, Modal; Devbox is Nix-only
- **AI agent integration**: We auto-generate AGENTS.md, MCP servers; Devbox has none

### Cons vs Devbox
- **Ecosystem**: Devbox has 400,000+ Nixpkgs packages; our package list is smaller
- **Startup**: Devbox shells are instant (after first pull); our Docker containers take 1-5s
- **Maturity**: Devbox is production-grade with 100+ contributors; we're starting from scratch
- **Windows**: Devbox works on WSL2; Docker Desktop on Windows is heavier

---

## 2. vs devenv (Cachix) -- 4,000+ stars

| Aspect | devenv | Our Tool |
|--------|-------|----------|
| Config | Nix (`devenv.nix`) | Filesystem (`sandbox/` directory) |
| Runtime | Nix (shell) | Docker (container) |
| Services | Built-in (postgres, redis, mysql, etc.) | Built-in (similar scope) |
| Process mgmt | Built-in process-compose | Docker Compose |
| Pre-commit hooks | Built-in | Via lifecycle hooks |
| Learning curve | Medium (Nix-lite) | Low (YAML) |

### Pros vs devenv
- **Learning curve**: YAML config vs Nix syntax. Devbox-style accessibility but with container isolation
- **Platform portability**: Docker + provider plugins vs Nix-only
- **AI agent integration**: Native MCP/extension support; devenv has none
- **Container workflow**: We generate Docker images and Compose files natively

### Cons vs devenv
- **Service management**: devenv's built-in process manager is more integrated than Docker Compose
- **Binary caching**: Cachix gives devenv fast binary cache; we rely on Docker layer caching
- **macOS performance**: devenv is native (no VM); Docker Desktop on macOS requires a VM
- **Pre-commit hooks**: devenv has built-in git hook management; we'd need hooks for this

---

## 3. vs Dev Containers (devcontainers/spec) -- Industry Standard

| Aspect | Dev Containers | Our Tool |
|--------|---------------|----------|
| Config | JSONC (`devcontainer.json`) | Filesystem (`sandbox/` directory) |
| IDE support | Excellent (VS Code, JetBrains) | CLI-first (IDE via generated config) |
| Features | OCI artifact features | Namespaced packages + languages |
| Services | Docker Compose sidecars | First-class service definitions |
| Platform | Docker only | Docker + provider plugins |
| Community | Largest ecosystem | New |

### Pros vs Dev Containers
- **Abstraction from Dockerfiles**: We generate Dockerfiles from config; devcontainer.json typically requires manual Dockerfiles
- **Service definitions**: Built-in postgres/redis/mongodb vs manual Docker Compose
- **Platform portability**: Dev Containers is Docker-only; we support Fly.io, Modal, etc.
- **AI agent integration**: Auto-generated AGENTS.md, MCP servers for OpenCode
- **Package namespacing**: `apt:`, `npm:`, `pip:` is clearer than devcontainer Features

### Cons vs Dev Containers
- **IDE integration**: Dev Containers has first-class VS Code/JetBrains support; we'd need to generate devcontainer.json from our config
- **Feature ecosystem**: 1,000+ community Features vs our smaller built-in library
- **Codespaces**: Dev Containers works with GitHub Codespaces natively; we'd need a provider adapter
- **Maturity**: Dev Containers is battle-tested across millions of repos
- **Port forwarding**: Dev Containers has sophisticated `forwardPorts`/`portsAttributes`; ours is simpler

---

## 4. vs sandboxd -- 696 stars

| Aspect | sandboxd | Our Tool |
|--------|---------|----------|
| Focus | AI agent sandboxes | General dev environments |
| Config | Hardcoded | Filesystem (`sandbox/` directory) |
| Services | None | Full service definitions |
| Preview URLs | Built-in (Traefik) | Planned via provider |
| Idle mgmt | Built-in | Via plugin |

### Pros vs sandboxd
- **Config-driven**: sandboxd has no user-facing config; we have a full `sandbox/` directory
- **Package management**: sandboxd provides base images; we let users declare packages
- **Service management**: sandboxd is container-only; we manage postgres/redis etc.
- **Generality**: We target all dev workflows; sandboxd targets AI agent sandboxes

### Cons vs sandboxd
- **Preview URLs**: sandboxd has built-in Traefik-powered preview URLs for every sandbox
- **Simplicity**: sandboxd is a single Go binary with minimal moving parts
- **Idle/wake**: sandboxd has mature idle management; ours is planned
- **AI agent focus**: sandboxd is purpose-built for AI agents; we serve a broader audience

---

## 5. vs mkenv -- 28 stars

| Aspect | mkenv | Our Tool |
|--------|------|----------|
| Auto-detection | Yes (scans project) | Yes (planned) |
| Security | Strong (blocks ~/.ssh, secret scan) | Planned (similar guardrails) |
| Config | None (auto-detect only) | YAML (auto-detect + override) |
| Services | None | Built-in service definitions |
| Policy engine | Built-in | Via plugins |
| License | Elastic License 2.0 | Open (TBD) |

### Pros vs mkenv
- **Config-driven**: We support explicit config; mkenv is auto-detect only
- **Service management**: We manage databases/caches; mkenv does not
- **AI agent integration**: Native; mkenv has none
- **Platform portability**: Provider model; mkenv is Docker-only

### Cons vs mkenv
- **Security defaults**: mkenv's secret scanning, path blocking, and network auditing are best-in-class
- **Policy engine**: mkenv lets teams enforce rules; ours is planned
- **Dynamic ports**: mkenv's auto port binding is slick; we use explicit port config
- **License**: ELv2 allows use but not redistribution; we'd need a truly open license

---

## 6. vs Asylum (Inventage AI) -- 200+ stars

| Aspect | Asylum | Our Tool |
|--------|-------|----------|
| Focus | Claude Code sandbox | General dev + AI agents |
| Kit system | Modular language/tool bundles | Namespaced packages + languages |
| Docker-in-Docker | Yes | Via tool declaration |
| Persistent caches | npm, pip, Maven, Gradle | BuildKit cache mounts |
| Config | Layered YAML | Single YAML + optional overrides |

### Pros vs Asylum
- **Service management**: We have built-in postgres/redis/mongodb; Asylum doesn't
- **Platform portability**: Provider model vs Docker-only
- **AI agent flexibility**: Supports Pi, OpenCode, Claude Code; Asylum is Claude Code primary
- **Generality**: We target all developers; Asylum targets AI agent users

### Cons vs Asylum
- **Kit system**: Asylum's modular kits (node, python, java, docker, ports) are well-designed and composable
- **Agent focus**: Asylum is purpose-built for Claude Code; our agent integration is additive
- **Credential scoping**: Asylum's per-project credential mounting is more refined
- **Docker-in-Docker**: Asylum has mature DinD support; ours is planned

---

## 7. vs DevPod (Loft Labs) -- 9,000+ stars

| Aspect | DevPod | Our Tool |
|--------|-------|----------|
| Config | devcontainer.json | `sandbox/` directory |
| Providers | Docker, AWS, GCP, Azure, SSH, K8s | Docker, Fly.io, Modal, SSH, K8s (planned) |
| Service mgmt | Docker Compose sidecars | First-class service definitions |
| IDE support | VS Code, JetBrains | CLI-first (agent-focused) |
| State mgmt | Workspace CRUD | Container lifecycle |

### Pros vs DevPod
- **Service definitions**: We have built-in service types; DevPod relies on Docker Compose
- **Config simplicity**: YAML is simpler than devcontainer.json for non-VS Code users
- **AI agent integration**: We auto-generate AGENTS.md, MCP, Pi extension; DevPod has none
- **Docker generation**: We generate Dockerfiles/Compose from config; DevPod requires existing Dockerfiles

### Cons vs DevPod
- **Provider ecosystem**: DevPod has mature providers for AWS, GCP, Azure, etc.; we'd need to build these
- **Spot instances**: DevPod supports spot/preemptible VMs for cost savings; ours is TBD
- **State management**: DevPod's workspace CRUD (create/delete/start/stop/list) is more comprehensive
- **Maturity**: DevPod is production-grade with 9,000+ stars
- **IDE integration**: DevPod connects VS Code and JetBrains to remote workspaces; we're CLI-first

---

## 8. vs Containarium (FootprintAI) -- 168 stars

| Aspect | Containarium | Our Tool |
|--------|-------------|----------|
| Runtime | LXC | Docker |
| Scale | 100+ envs per VM | 1-N containers per host |
| Access | SSH | CLI exec + SSH |
| Stack provisioning | Pre-defined stacks | Declarative packages |
| Use case | Multi-tenant dev | Per-project dev |

### Pros vs Containarium
- **Familiarity**: Docker is more widely understood than LXC
- **Config-driven**: Declarative YAML vs pre-defined stacks
- **Developer experience**: CLI-first vs SSH-first
- **AI agent integration**: Native MCP/extension support

### Cons vs Containarium
- **Resource efficiency**: LXC is significantly more efficient than Docker for 100+ environments
- **Full OS isolation**: LXC provides full init system per container
- **Cost**: Containarium runs hundreds of envs on a single $20 VM
- **Persistence**: LXC containers are designed for long-running persistence

---

## 9. vs Agentrove -- 290 stars

| Aspect | Agentrove | Our Tool |
|--------|---------|----------|
| Focus | Multi-agent coding workspace | Sandbox environment manager |
| Interface | Web app + macOS + iOS | CLI + generated configs |
| Agents | Claude, Codex, Copilot, Cursor, OpenCode | Pi, OpenCode (via MCP/extensions) |
| Sandboxes | Docker per workspace | Docker + provider plugins |
| Config | Container-based | Config-to-container generation |

### Pros vs Agentrove
- **Lightweight**: CLI tool vs full web app with database, Redis, API server
- **Config-driven**: `sandbox/` directory in any repo vs Agentrove's workspace management
- **Platform portability**: Provider model vs Docker-only
- **Package management**: Declarative packages vs pre-built images

### Cons vs Agentrove
- **Multi-agent UI**: Agentrove's web interface for managing multiple AI agents is compelling
- **ACP support**: Agentrove implements Agent Communication Protocol natively
- **Session management**: Agentrove's workspace sessions with chat, file tree, terminal
- **All-in-one**: Agentrove bundles sandbox + editor + agent in one deployable unit

---

## Summary: Why Build This?

### Where Every Competitor Falls Short

| Need | Devbox | devenv | Dev Containers | sandboxd | mkenv | Asylum | DevPod | Containarium |
|------|--------|--------|---------------|---------|-------|--------|--------|-------------|
| Simple filesystem config | JSON | Nix | JSONC | None | None | YAML | JSONC | Pre-defined |
| Service definitions | Plugin | Built-in | Compose | No | No | No | Compose | Stack scripts |
| Platform abstraction | No | No | No | No | No | No | Yes | LXC only |
| AI agent hooks | No | No | No | Implicit | No | Claude | No | No |
| Auto-generate Dockerfile | Yes | Container cmd | Manual | N/A | No | No | No | No |
| Auto-generate env vars | Manual | Manual | Manual | No | No | Manual | No | No |
| Lifecycle hooks | init_hook | enterShell | postCreate | No | No | No | No | No |
| Prebuilt images | No | No | Pinned tags | No | No | No | No | No |

### Our Differentiator

A tool that combines:
1. **Devbox's simplicity** (config-driven) + **Eve's filesystem-first design** (config as directory of files) + **devenv's services** (built-in postgres/redis) + **DevPod's provider model** (any infrastructure) + **Asylum's AI agent focus** (MCP, Pi, OpenCode) + **mkenv's fast startup** (prebuilt images)
2. **Config-to-container generation** -- users never write a Dockerfile or Docker Compose file
3. **Auto-generated context** -- AGENTS.md with connection strings, MCP servers for agents
4. **Platform-agnostic by design** -- same config works on Docker, Fly.io, Modal, SSH, K8s
5. **Generates devcontainer.json** -- users get VS Code / Codespaces / JetBrains support for free

### Key Risks

- **Ecosystem bootstrapping**: Building a package library from zero is hard. *Mitigation: Use Nix as backend for package resolution (like Devbox), giving 400k+ packages from day one.*
- **Docker dependency**: Requires Docker on every platform (macOS VM overhead). *Mitigation: Provider abstraction enables Fly.io/Modal/remote Docker for native performance.*
- **Competing with standards**: Dev Containers is deeply entrenched; we need a compelling reason to switch. *Mitigation: Generate devcontainer.json as output, don't compete.*
- **Provider maintenance**: Each provider (Fly.io, Modal, etc.) is a significant ongoing maintenance burden. *Mitigation: Start with local Docker only. Add providers incrementally after v1.*
- **AI agent landscape**: The agent tool space evolves rapidly; keeping integrations current is costly. *Mitigation: MCP server + AGENTS.md generation covers 80% of use cases. Plugins for the rest.*
- **Scope creep**: The proposed architecture tries to solve everything at once. *Mitigation: Strict MVP scope (see SCOPE.md). Defer plugins, providers, agent integrations to v0.2+.*

### Recommended MVP Scope (4-6 weeks)

| Week | Deliverable |
|------|-------------|
| 1 | `sandbox/` directory structure + file schemas (languages, packages: apt/npm/pip, services: postgres/redis) + validators |
| 2 | Config → optimized Dockerfile generator (layer ordering, cache mounts, .dockerignore) |
| 3 | Config → docker-compose.yaml generator (service healthchecks, env wiring, volumes) |
| 4 | `sandbox build` (buildx + registry cache) + `sandbox up` (compose up + health waits) |
| 5 | `sandbox init` (auto-detect from package.json/pyproject.toml/go.mod) + lock file |
| 6 | `sandbox generate devcontainer.json` + `AGENTS.md` + basic hooks (`build.post`, `start.post`) |

**Defer to v0.2+**: Provider plugins, Pi/OpenCode integrations, nix/cargo/go packages, MongoDB/MySQL/MinIO services, plugin system, idle management, preview URLs.
