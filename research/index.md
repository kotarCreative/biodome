# Sandbox Manager -- Research Overview

## Project Goal

A CLI tool that allows adding simple config files to any repository for:
1. Creating a Docker image with all packages outlined in the config
2. Starting necessary dependencies (databases, caches, etc.) for a full dev environment
3. Providing hooks for customization and integration with AI coding agents (pi.dev, OpenCode)

---

## Research Documents

| Document | Contents |
|----------|----------|
| [existing-landscape.md](existing-landscape.md) | Analysis of 10 open-source projects in the dev sandbox space |
| [infrastructure.md](infrastructure.md) | Evaluation of infrastructure backends (Docker, Fly.io, Modal, AWS, K8s, etc.) |
| [fast-startup.md](fast-startup.md) | Docker build optimization, caching strategies, and "instant" start techniques |
| [hooks-integration.md](hooks-integration.md) | Hook architecture patterns, pi.dev integration, OpenCode integration |

---

## Key Findings

### 1. The Space is Fragmented
No single tool dominates. There's room for a tool that combines:
- Simple config format (like Devbox's JSON)  
- Service management (like devenv's processes)
- AI agent hooks (like Asylum/Open Harness)
- Fast startup (like mkenv's auto-detection)
- Self-hostable on any infrastructure (like DevPod's provider model)

### 2. Docker is the Universal Runtime
Nearly every tool reviewed uses Docker. Start there. Add alternative runtimes (LXC, Firecracker) via provider plugins later.

### 3. Fast Startup Requires Multiple Strategies
- Prebuilt images in a registry (config changes trigger CI rebuild)
- BuildKit cache mounts for package manager caches
- Proper Dockerfile ordering (deps before source)
- External/registry cache for CI
- Background image pre-pull

### 4. Infrastructure Abstraction is Key
Design a provider plugin system from day one:
- **Local Docker** (baseline, always available)
- **Fly.io** (persistent, globally-distributed, scale-to-zero)
- **Modal** (ephemeral, GPU-capable)
- **SSH remote Docker** (simple self-hosted option)
- **Kubernetes** (later, for enterprise)

### 5. Hooks Enable Agent Integration
Both pi.dev and OpenCode have extensible architectures:
- **OpenCode**: Plugins (TypeScript), hooks.yaml, MCP servers, custom commands
- **pi.dev**: Extensions (TypeScript), skills, prompt templates, packages

The sandbox manager should:
- Auto-generate `AGENTS.md` / `CLAUDE.md` context files
- Provide an MCP server for OpenCode
- Provide a Pi extension/packge for Pi
- Support lifecycle hooks at build/start/stop phases

---

## Proposed Architecture (High-Level)

```
sandbox/ directory (config in any repo)
       |
       v
[sandbox CLI]
       |
       |-- Config Discovery & Parser
       |-- Dockerfile Generator (optimized)
       |-- Provider Plugin Interface
       |     |-- Docker (local)
       |     |-- Fly.io
       |     |-- Modal
       |     |-- SSH Remote
       |
       |-- Hook System
       |     |-- build.pre / build.post
       |     |-- start.post
       |     |-- stop.pre
       |
       |-- Agent Integration Layer
       |     |-- OpenCode MCP server
       |     |-- Pi extension package
       |     |-- AGENTS.md generator
       |
       |-- Plugin System (extend hooks, providers, tools)
```

## Next Steps

1. Define the `sandbox/` directory structure and file schemas
2. Build the Dockerfile generator (config -> optimized Dockerfile)
3. Implement the CLI with local Docker provider
4. Add service management (Docker Compose generation)
5. Add lifecycle hooks
6. Build OpenCode MCP server and Pi extension
7. Add prebuild CI/CD workflow generation
