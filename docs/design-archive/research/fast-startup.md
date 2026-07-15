# Fast Startup Practices for Docker Dev Environments

## Overview

Startup time is critical for dev environment tools. Developers expect to go from `git clone` to productive coding in seconds, not minutes. This document catalogs techniques for minimizing startup time.

---

## 1. Docker Build Cache Optimization

### Layer Ordering (Most Important)
Docker caches layers by instruction. Once a layer is invalidated, all subsequent layers rebuild. Order instructions from least-frequently-changing to most-frequently-changing.

```
// Good: dependencies installed before source code copy
FROM node:20
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

// Bad: source copy before deps -- any source change rebuilds deps
FROM node:20
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
```

**Source**: https://docs.docker.com/build/building/best-practices/

### Cache Mounts (`--mount=type=cache`)
BuildKit cache mounts persist data across builds without including it in any layer. This is the single highest-leverage optimization.

```dockerfile
# APT package cache
RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl git

# npm cache
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline

# pip cache
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Go module cache
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Go build cache (incremental compilation)
RUN --mount=type=cache,target=/root/.cache/go-build \
    go build -o /app/server .
```

**Source**: https://docs.docker.com/build/cache/optimize

### External/Registry Cache
For CI environments where builders are ephemeral, push cache to a registry:

```bash
# Push cache to registry
docker buildx build --cache-to type=registry,ref=myorg/myapp:cache,mode=max \
                     --cache-from type=registry,ref=myorg/myapp:cache \
                     -t myorg/myapp:latest .

# mode=max caches all intermediate layers (not just final image)
```

**Source**: https://github.com/moby/buildkit/blob/master/README.md

### Inline Cache
Embed cache metadata in the image itself -- useful for single-registry workflows:

```bash
docker buildx build --cache-to type=inline --push -t myorg/myapp:latest .
```

**Source**: https://docs.docker.com/build/cache/optimize

---

## 2. Base Image Selection

### Distroless / Minimal Bases
- **Alpine Linux**: ~5MB. Fast to pull. Uses musl libc (can cause compatibility issues).
- **Distroless**: Google's minimal images (~20MB). No shell, no package manager. More secure.
- **Debian Slim**: ~80MB. glibc-based. Good balance of size and compatibility.
- **Ubuntu LTS**: ~150MB. Largest, most compatible.

### Specialized Language Images
- `python:3.12-slim` instead of `python:3.12` (saves ~300MB)
- `node:20-alpine` instead of `node:20` (saves ~400MB)
- Use `golang:1.22-alpine` for build stages, scratch for runtime

### Multi-arch Images with Manifests
Use `docker buildx build --platform linux/amd64,linux/arm64` to build once, run anywhere.

---

## 3. Build Context Minimization

### .dockerignore
Every file in the build context is sent to the Docker daemon. A large context slows build start.

```
node_modules/
.git/
dist/
build/
*.log
.env
.venv/
__pycache__/
*.pyc
.terraform/
*.tfstate
```

**Source**: https://docs.docker.com/build/building/best-practices/

### Bind Mounts for Source
Instead of `COPY . .`, use bind mounts to access source without adding it to layers:

```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /app
RUN --mount=type=bind,target=. \
    --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -o /app/server .
```

### Keep Context Directory Clean
Run builds from a directory with only necessary files. Use `docker build -f path/to/Dockerfile .` where `.` is minimal.

---

## 4. Prebuilding and Image Caching

### Prebuilt Dev Images
Build and push dev images to a registry. Users pull instead of building:

```yaml
# sandbox/config.yaml
image: ghcr.io/myorg/dev-env:node20-python312
```

```yaml
# sandbox/env.yaml
packages:
  apt:
    - build-essential
  pip:
    - pytest
```

### CI/CD Prebuild Pipelines
Use GitHub Actions or similar to rebuild dev images on config changes:

```yaml
# .github/workflows/prebuild-devimage.yml
on:
  push:
    paths:
      - 'sandbox/**/*.yaml'
```

### Layer Prefetching
When a user clones a repo and starts the sandbox, the prebuilt image should already be cached from a background pull. Tools can optimize startup by warming the Docker cache for likely images.

---

## 5. BuildKit Parallelism

### Parallel Stage Execution
BuildKit automatically runs independent multi-stage build stages in parallel:

```dockerfile
FROM node:20-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ .
RUN npm run build

FROM golang:1.22-alpine AS backend
WORKDIR /app
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend/ .
RUN --mount=type=cache,target=/root/.cache/go-build go build -o /app/api .

FROM alpine:3.19
COPY --from=frontend /app/dist /app/dist
COPY --from=backend /app/api /app/api
CMD ["/app/api"]
```

BuildKit runs `frontend` and `backend` stages in parallel, nearly halving build time on multi-core machines.

**Source**: https://github.com/moby/buildkit

### Concurrent Dependency Resolution
BuildKit resolves all dependencies concurrently, not sequentially.

---

## 6. Runtime Startup Optimization

### Application-Level Health Checks
Define health checks for services to signal readiness. Compose waits for dependencies:

```yaml
services:
  db:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 2s
      retries: 10
```

### Dependency Ordering
Start services in dependency order (DAG-based), not sequentially:

```yaml
services:
  app:
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
```

### Hot Reload vs. Container Rebuild
During active development, prefer bind mounts + hot reload (nodemon, air, etc.) over rebuilding the container image.

### Snapshot/Restore for Stateful Services
- For services with expensive startup (ML models, large databases), use volume snapshots.
- Support `docker commit`-style snapshotting or explicit save/restore workflows.

---

## 7. Package Manager Caching Patterns

| Package Manager | Cache Mount Target | Key Flag |
|----------------|-------------------|----------|
| apt | `/var/cache/apt` | `--no-install-recommends` |
| npm | `/root/.npm` | `--prefer-offline` |
| pip | `/root/.cache/pip` | `--no-cache-dir` (don't cache; use mount) |
| Go modules | `/go/pkg/mod` | (automatic) |
| Go build | `/root/.cache/go-build` | (automatic) |
| Maven/Gradle | `/root/.m2` | `-o` (offline mode) |
| Rust/Cargo | `/usr/local/cargo/registry` | (automatic) |
| Bundler | `/usr/local/bundle` | `--deployment` |

**Source**: https://depot.dev/blog/how-to-use-cache-mount-to-speed-up-docker-builds

---

## 8. Achieving "Instant" Start

### The Startup Hierarchy

1. **Cold (no cache)**: Pull base image + install all packages. **~5-10 minutes.**
2. **Warm (local cache)**: Image layers cached locally. Container starts in **~5 seconds.**
3. **Pre-warmed (background pull)**: Image pulled before user starts. Container starts in **~1 second.**

### Recommended Strategy

**For first-time setup:**
- Provide prebuilt images in a registry (GitHub Container Registry, Docker Hub)
- Use `sandbox.{yaml,json}` to define packages, not Dockerfiles
- Generate Dockerfile from the config automatically
- Push prebuilt images on config changes (CI/CD)

**For subsequent starts:**
- Keep images cached locally (Docker layer cache)
- Use BuildKit cache mounts for package manager caches
- Optimize Dockerfile instruction ordering
- Keep `.dockerignore` minimal

**For "instant" start (target: <5s):**
- Pull the prebuilt image in the background before the user asks
- Use image manifests to fetch multi-arch images without specifying platform
- Consider Firecracker microVMs (Fly.io, E2B) which boot in <500ms from a cached base

---

## 9. Config-to-Image Pipeline (Proposed)

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
  |-- docker buildx build --cache-to/--cache-from (registry cache)
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

### Key Design Decisions

1. **Config-driven, not Dockerfile-driven**: Users describe *what* they need (packages, tools), not *how* to install them. The tool generates the optimal Dockerfile.
2. **Automatic Dockerfile optimization**: The generated Dockerfile follows all best practices (layer ordering, cache mounts, `.dockerignore`).
3. **Prebuild in CI/CD, not CLI**: On config changes, GitHub Actions (or CI of choice) prebuilds the image. The CLI only pulls prebuilt images. Background warmup is a CI concern, not a CLI feature.
4. **BuildKit Bake for parallel multi-target builds**: Use `docker buildx bake` with HCL/JSON definition for dev/test/prod images in one invocation.
5. **Lock file for reproducibility**: A `sandbox.lock` pins exact versions for all packages across `apt`, `npm`, `pip` namespaces.
6. **Generate devcontainer.json as output**: Users get VS Code / Codespaces / JetBrains support for free without writing Dev Container config.

### MVP Scope (v1) vs Future

| Feature | v1 | Future |
|---------|----|--------|
| Local Docker provider | ✅ | — |
| Config → Dockerfile generator | ✅ | — |
| Config → docker-compose.yaml generator | ✅ | — |
| Config → devcontainer.json generator | ✅ | — |
| Registry cache (buildx --cache-to/from) | ✅ | — |
| BuildKit cache mounts (apt, npm, pip, Go) | ✅ | — |
| Lock file (sandbox.lock) | ✅ | — |
| Prebuild CI/CD workflow generation | ✅ | — |
| Background CLI warmup | ❌ | v0.2 |
| BuildKit Bake multi-target | ❌ | v0.2 |
| Fly.io / Modal providers | ❌ | v0.3 |
| stargz/nydus lazy loading | ❌ | v0.3 |
| Firecracker / Kata Containers | ❌ | v0.4 |

## Sources

- Docker Build Cache: https://docs.docker.com/build/cache/optimize
- Docker Best Practices: https://docs.docker.com/build/building/best-practices/
- BuildKit README: https://github.com/moby/buildkit
- Depot Blog on Cache Mounts: https://depot.dev/blog/how-to-use-cache-mount-to-speed-up-docker-builds
- BuildKit Cache Optimization: https://blog.gntech.me/posts/2026-05-21-docker-buildkit-cache-optimization/
- Asylum (fast sandbox startup patterns): https://github.com/inventage-ai/asylum
- Devilbox (Docker caching): https://dev.to/saishanmukkha/docker-cache-isnt-broken-youre-invalidating-it-mof
