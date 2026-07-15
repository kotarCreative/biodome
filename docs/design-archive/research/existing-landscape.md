# Existing Open Source Dev Sandbox Management Projects

## Overview

There is a rich ecosystem of open-source tools for managing development environments and sandboxes. This document catalogs the most relevant projects, their architectures, and key differentiators to inform the design of our own sandbox manager.

---

## 1. Dev Containers (devcontainers/spec)

- **Repository**: https://github.com/devcontainers/spec
- **Language**: N/A (specification) + CLI in Go
- **License**: MIT
- **Stars**: 5,000+

### Description
An open specification for configuring development environments in containers. Supported by VS Code, GitHub Codespaces, JetBrains, and many CDEs. Uses `devcontainer.json` + `Dockerfile` or `docker-compose.yml`.

### Key Features
- Standardized config format (`devcontainer.json`)
- Lifecycle scripts (`postCreateCommand`, `postStartCommand`, etc.)
- Feature system for reusable tooling bundles
- CI integration via `devcontainers/ci` GitHub Action

### Architecture
- Container-based (Docker/Podman)
- VS Code Remote — Containers extension
- CLI tool for headless use

### Pros
- Widely adopted, industry standard
- Excellent IDE integration
- Large feature ecosystem
- Works with GitHub Codespaces out of the box

### Cons
- Dockerfile-centric, can be complex
- Image drift if tags aren't pinned to digests
- Container overhead on macOS (VM required)
- No native process management for services

---

## 2. Devbox (Jetify)

- **Repository**: https://github.com/jetify-com/devbox
- **Language**: Go
- **License**: Apache 2.0
- **Stars**: 11,800+

### Description
A CLI tool wrapping Nix in a familiar JSON config and CLI. Provides isolated shells without container overhead. Generates DevContainer configs and Dockerfiles from the same source of truth.

### Key Features
- JSON config (`devbox.json` + `devbox.lock`)
- 400,000+ package versions from Nixpkgs
- `devbox shell` for instant isolated shells
- DevContainer generation (`devbox generate devcontainer`)
- Dockerfile generation (`devbox generate dockerfile`)
- Service management via `devbox services`
- Devbox Cloud for managed remote environments

### Architecture
- Nix-powered under the hood
- No container/VM required for local shells
- Can output containers for production

### Pros
- No learning curve (vs raw Nix)
- Fast startup (shell activation is instant)
- Cross-platform (macOS, Linux, WSL2)
- DevContainer compatibility

### Cons
- Nix dependency for the first setup
- First `devbox shell` is slow (5-15 min)
- No native Windows support (WSL2 required)
- Complex package version pinning

---

## 3. devenv (Cachix)

- **Repository**: https://github.com/cachix/devenv
- **Language**: Nix
- **License**: Apache 2.0
- **Stars**: 4,000+

### Description
A Nix-based tool for declarative dev environments with built-in service management, pre-commit hooks, and process supervision.

### Key Features
- `devenv.nix` configuration
- Integrated process manager (supervisord-style)
- Built-in service definitions (databases, queues, etc.)
- Pre-commit hooks built in
- Language-specific module system
- Container generation (`devenv container`)
- Cachix binary cache integration

### Architecture
- Nix-powered
- Deeper Nix integration than Devbox
- Can drop down to raw Nix when needed

### Pros
- More powerful than Devbox
- Service management built-in
- macOS native (no VM needed)
- Strong caching support

### Cons
- Still requires Nix knowledge for advanced use
- Learning curve
- Nix language syntax for config
- Smaller community than Devbox

---

## 4. sandboxd

- **Repository**: https://github.com/tastyeffectco/sandboxd
- **Language**: Go
- **License**: MIT
- **Stars**: 696

### Description
Self-hosted dev sandboxes with preview URLs. One command setup, designed for AI coding agents and SaaS platforms. Runs Docker containers with Traefik for routing.

### Key Features
- One Go binary + Docker
- Traefik v3 for preview URL routing
- SQLite (WAL mode) for state
- Idle management (stop-on-idle + wake-on-request)
- No Kubernetes required

### Architecture
- Control plane: single Go binary
- Container runtime: Docker + hardened runc
- Edge: Traefik v3 Docker provider
- State: SQLite

### Pros
- Simple architecture
- Self-contained (one binary)
- Good for AI agent sandboxes
- Preview URLs out of the box

### Cons
- Early stage (v0.2.0)
- Single Docker host only (no K8s)
- Limited language/build tooling
- No config file spec for easy adoption

---

## 5. mkenv

- **Repository**: https://github.com/0xa1bed0/mkenv
- **Language**: Go
- **License**: Elastic License 2.0
- **Stars**: 28

### Description
Creates disposable Docker containers for projects with auto-detection of stacks. Focus on security: blocks sensitive paths, pre-flight secret scanning, network auditing.

### Key Features
- Auto-detection of project runtimes (Node, Go, etc.)
- No Dockerfile needed
- Dynamic port binding (no port mapping config)
- Policy engine for team enforcement
- Pre-flight secret scanning
- Network audit logging

### Architecture
- Docker container-based
- Dynamic port forwarding
- Security guardrails built-in

### Pros
- Zero config for simple projects
- Strong security defaults
- Policy engine for teams
- Good for AI agents (repos that need isolation)

### Cons
- Elastic License (not fully open source)
- Small community
- Early stage
- No service management

---

## 6. Asylum (Inventage AI)

- **Repository**: https://github.com/inventage-ai/asylum
- **Language**: Go
- **License**: MIT
- **Stars**: 200+

### Description
Docker sandbox for AI coding agents, focused on Claude Code. Features Docker-in-Docker, persistent caches, and a modular kit system.

### Key Features
- Kit system (modular language/tool bundles)
- Docker-in-Docker support
- Persistent caches (npm, pip, Maven, Gradle)
- Layered config (global -> project -> local -> CLI)
- Real host path mounting
- Single binary

### Architecture
- Docker container-based
- Go binary with no runtime deps beyond Docker
- Config: layered YAML

### Pros
- Modular kit system (enable per-project)
- Persistent caches across sessions
- Credential scoping (per-project)
- Good for AI agent workflows

### Cons
- Focused on Claude Code primarily
- Less general-purpose
- Smaller ecosystem

---

## 7. Open Harness

- **Repository**: https://github.com/ryaneggz/open-harness
- **Language**: Shell/TypeScript
- **License**: MIT
- **Stars**: 100+

### Description
Isolated, pre-configured sandbox containers for AI coding agents (Claude Code, OpenAI Codex, Pi Agent). Runs one container with multiple git worktrees.

### Key Features
- Docker Compose-based
- Multiple agent support (Claude, Codex, Pi Agent)
- Git worktree isolation per agent
- Heartbeat daemon for scheduled runs
- Compose overlays for optional services (Postgres, SSH, etc.)

### Architecture
- Single Docker container + N git worktrees
- Node daemon inside container for orchestration
- `.devcontainer/` structure

### Pros
- Simple setup (Docker Compose only)
- Multiple agents from one container
- Good for autonomous agent workflows

### Cons
- Single container model (limited isolation)
- Less suitable for team/production use
- Focused on AI agents, not general dev

---

## 8. Containarium (FootprintAI)

- **Repository**: https://github.com/FootprintAI/Containarium
- **Language**: Go
- **License**: Apache 2.0
- **Stars**: 168

### Description
Hundreds of isolated Linux development environments on a single VM using LXC containers. SSH-based access with cloud-native automation.

### Key Features
- LXC-based (not Docker)
- SSH jump host access
- Stack provisioning (Node, Python, Go, Rust, etc.)
- Single VM can host hundreds of environments
- Persistent containers

### Architecture
- LXC system containers
- Go CLI + gRPC
- Ubuntu 24.04 LTS host

### Pros
- Extremely resource-efficient
- Full Linux OS per container
- Can run Docker inside containers
- Good for multi-tenant scenarios

### Cons
- LXC complexity vs Docker
- SSH-based rather than CLI-first
- Less familiar tooling for most devs

---

## 9. DevPod (Loft Labs)

- **Repository**: https://github.com/loft-sh/devpod
- **Language**: Go
- **License**: MPL-2.0
- **Stars**: 9,000+

### Description
Open-source tool that runs dev containers on any backend -- local Docker, cloud VM, Kubernetes, or SSH. Uses the standard `devcontainer.json` spec.

### Key Features
- Provider-agnostic (Docker, AWS, GCP, Azure, SSH, K8s)
- Standard `devcontainer.json` format
- Provider plugin system
- Spot instance support for cost savings
- VS Code and JetBrains support

### Architecture
- Client-server model
- Providers as plugins
- Container-based via devcontainer spec

### Pros
- No vendor lock-in
- Same config works with Codespaces
- Cost efficient (spot instances)
- Active development, large community

### Cons
- Provider setup required
- Still Docker-centric on each provider
- No built-in service management
- Complex multi-repo scenarios

---

## 10. Daytona (formerly open source, now commercial)

- **Repository**: https://github.com/daytonaio/daytona (archived June 2026, moved private)
- **Language**: Go
- **License**: Apache 2.0

### Description
Secure infrastructure runtime for AI-generated code execution. Provides sandboxes with full isolation, dedicated kernel, filesystem, and network stack.

### Key Features
- Sandboxes in <90ms startup
- SDKs for Python, TypeScript
- Full CRUD for sandbox lifecycle
- Git, LSP, process execution APIs
- Snapshots for state persistence

### Architecture
- OCI/Docker compatibility
- Customer-managed compute
- Control plane + runners

### Pros
- Extremely fast sandbox creation
- Rich API/SDK ecosystem
- Good for agent workflows

### Cons
- No longer open source
- Complex self-hosted deployment
- Built for AI agents, not general dev

---

## Comparison Matrix

| Tool | Config Format | Runtime | Isolation | Service Mgmt | AI Agent Focus | Local-First |
|------|--------------|---------|-----------|--------------|----------------|-------------|
| Dev Containers | devcontainer.json | Docker | Container | Docker Compose | Partial | Yes |
| Devbox | devbox.json | Nix | Shell | Via plugins | Partial | Yes |
| devenv | devenv.nix | Nix | Shell | Built-in | Partial | Yes |
| sandboxd | (hardcoded) | Docker | Container | No | Yes | No |
| mkenv | (auto-detect) | Docker | Container | No | Yes | Yes |
| Asylum | YAML | Docker | Container | Kit system | Yes | Yes |
| Open Harness | Docker Compose | Docker | Container | Compose overlays | Yes | Yes |
| Containarium | Stack configs | LXC | System container | Stack scripts | Partial | No |
| DevPod | devcontainer.json | Pluggable | Container | Docker Compose | Partial | Yes |

## Key Takeaways for Sandbox Manager Design

1. **Config format should be simple**: YAML/JSON is preferred. Devbox's approach (JSON + lock file) is most accessible.
2. **Docker is the universal runtime**: Nearly every tool uses Docker. Support for alternative runtimes (LXC, Firecracker) can be layered.
3. **Service management is a gap**: Most tools rely on Docker Compose for services. Built-in process management (like devenv) is rare and valuable.
4. **AI agent hooks are in demand**: sandboxd, Asylum, Open Harness, and Daytona all target AI agent workflows. This is a growing space.
5. **No dominant tool exists**: The space is fragmented. There is room for a tool that combines:
   - Simple config format (like Devbox)
   - Service management (like devenv)
   - AI agent hooks (like Asylum plugins)
   - Fast startup (like mkenv)
   - Self-hostable on any infrastructure (like DevPod)
6. **Local-first with cloud optional**: Most teams want local dev that can optionally run remotely. DevPod's provider model is instructive.
