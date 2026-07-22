# Infrastructure Options for Dev Sandbox Execution

## Overview

A sandbox manager needs to support multiple infrastructure backends. This document evaluates the major options for running development sandboxes -- from local Docker to cloud providers and specialized platforms.

---

## 1. Local Docker (Baseline)

**Type**: Container runtime
**Isolation**: Container (shared kernel)
**Startup**: Seconds (cached images)
**Cost**: Free

### Description

Docker Engine runs containers natively on Linux. On macOS/Windows, Docker Desktop provides a VM-managed environment. This is the default runtime for almost all dev environment tools.

### Strengths

- Universal -- runs on every OS
- Huge ecosystem of base images
- Docker Compose for multi-service setups
- BuildKit for fast builds with caching
- No cloud dependency

### Weaknesses

- No multi-tenant isolation (shared kernel)
- macOS/Windows require a VM (slower)
- Image management overhead
- No built-in idle management

### Best For

- Local development
- Single-user scenarios
- CI/CD runners

---

## 2. GitHub Codespaces

**Type**: Managed cloud CDE
**Runtime**: VM (not directly exposed)
**Isolation**: Full VM
**Startup**: 30-60s (cold); 5-10s (prebuilt)
**Cost**: $0.18/core-hour

### Description

GitHub-managed cloud development environments. Uses `devcontainer.json` for configuration. Prebuilds available via GitHub Actions.

### Integration Points

- `devcontainer.json` is the config format
- Lifecycle hooks via devcontainer spec
- VS Code in browser or desktop
- JetBrains Gateway support

### Strengths

- Seamless GitHub integration
- Prebuilds for fast startup
- Managed service (no ops)
- Rich IDE support

### Weaknesses

- GitHub-only (no GitLab/Bitbucket)
- No self-hosted option
- Limited customization of networking
- Expensive at scale

### Best For

- Teams already on GitHub
- VS Code-heavy workflows

---

## 3. AWS (EC2 / ECS / EKS)

**Type**: IaaS / Container orchestration
**Runtime**: VM / Docker on VM
**Isolation**: Full VM / Container
**Startup**: 30s-2min (EC2); 10-30s (ECS Fargate)
**Cost**: Variable (pay per resource)

### Description

Amazon Web Services offers the broadest set of infrastructure options. For sandboxes, the relevant services are EC2 (VMs), ECS (Docker orchestration), and EKS (Kubernetes).

### Integration Points

- EC2 Instance Connect / SSM for SSH
- ECS with Fargate for serverless containers
- EBS snapshots for state persistence
- CloudWatch for logging
- VPC for network isolation

### Strengths

- Full control over infrastructure
- Every possible feature (networking, storage, etc.)
- Enterprise compliance (SOC, HIPAA, PCI)
- Spot instances for 60-70% cost savings

### Weaknesses

- Complex setup
- Ops burden (unless using higher-level services)
- Predictable cost management is hard
- No dev-environment-specific features

### Best For

- Enterprise deployments
- Custom infrastructure requirements
- Teams with DevOps expertise

---

## 4. Fly.io

**Type**: Edge application platform
**Runtime**: Firecracker microVMs
**Isolation**: microVM (hardware-level)
**Startup**: ~100ms (warm), ~1-3s (cold)
**Cost**: Usage-based (generous free tier: 3 VMs)

### Description

Runs applications as lightweight Firecracker microVMs distributed across 35+ global regions. Accepts Docker or OCI-compatible images. Features scale-to-zero, Anycast networking, and persistent volumes.

### Integration Points

- Dockerfile-first deployment
- `flyctl` CLI
- Per-user/per-robot app model
- Fly Volumes for persistent storage
- Auto-stop/start for idle management
- `fly-replay` for smart routing

### Strengths

- Near-instant cold starts (Firecracker)
- Global edge deployment (35+ regions)
- Scale-to-zero for cost control
- Per-user app isolation model
- Simple CLI and DX

### Weaknesses

- No GPU support (CPU only)
- Limited to app hosting (not general VM)
- Volume attach latency
- No built-in dev environment hooks

### Best For

- Per-user dev environments
- Global low-latency access
- AI coding agent sandboxes (via Sprites)

#### Fly.io Sprites

A newer Fly.io offering specifically for sandbox environments:

- Persistent filesystem across sessions
- CLI and API access
- Unlimited runtime (no hard time limits)
- Firecracker microVM isolation
- Cold starts available between tasks

---

## 5. Modal

**Type**: Serverless cloud for AI/ML
**Runtime**: gVisor containers
**Isolation**: gVisor (application-level kernel)
**Startup**: Sub-second cold starts; GPU memory snapshotting reduces startup ~10x
**Cost**: Pay-per-second; free tier with $30/month credits

### Description

Serverless platform for AI/ML workloads. Runs containers with gVisor isolation. Supports CPU and GPU workloads. Python-first SDK, autoscaling, multi-cloud pooling.

### Integration Points

- Python SDK (`@app.function`, `@app.cls`)
- Sandbox API for code execution
- GPU memory snapshotting
- Multi-cloud (AWS, GCP, Azure pooling)

### Strengths

- Fastest cold starts in class
- GPU on demand (H100, A100)
- Pay-per-second billing (no idle cost)
- Strong AI/ML focus

### Weaknesses

- Python-first (less natural for Go/Node tools)
- No persistent volumes (ephemeral by design)
- gVisor isolation has syscall limitations
- No built-in dev environment features

### Best For

- AI/ML development sandboxes
- GPU-accelerated workloads
- Ephemeral code execution needs

---

## 6. Kubernetes

**Type**: Container orchestration
**Runtime**: Docker/containerd
**Isolation**: Container (with possible Kata/Firecracker)
**Startup**: 5-30s (depending on image caching)
**Cost**: Control plane + node costs

### Description

Standard container orchestration platform. Can run anywhere (self-hosted, EKS, GKE, AKS). Powerful but complex for dev environments.

### Integration Points

- Pods for sandbox execution
- PersistentVolumeClaims for state
- NetworkPolicies for isolation
- Resource quotas for cost control
- CRDs for sandbox lifecycle management

### Strengths

- Universal orchestration
- Rich ecosystem (Helm, operators, etc.)
- Works with any cloud
- Strong isolation via Kata/Firecracker containers

### Weaknesses

- Complex setup and maintenance
- Overkill for simple dev environments
- State management is hard (PVCs are not instant)
- Requires dedicated team for operations

### Best For

- Large-scale multi-tenant deployments
- Teams already using K8s
- Enterprise compliance requirements

---

## 7. E2B

**Type**: Managed cloud sandbox service
**Runtime**: Firecracker microVMs
**Isolation**: microVM (hardware-level)
**Startup**: ~200ms
**Cost**: Usage-based (BYOC available for enterprise)

### Description

Managed service for ephemeral, session-based code execution. Firecracker microVMs for isolation. Primarily targets AI agent code execution.

### Integration Points

- REST API
- SDKs (Python, TypeScript)
- BYOC on AWS for enterprise
- Docker/OCI image support

### Strengths

- Fast startup
- Good for ephemeral agent sessions
- Managed service (no ops)

### Weaknesses

- Ephemeral only (session length limits)
- CPU-only (no GPU)
- Managed only (BYOC is enterprise-only)
- Limited customization

### Best For

- Short-lived AI agent code execution
- Ephemeral sandbox needs

---

## 8. Northflank

**Type**: Managed cloud platform
**Runtime**: Docker + Kata Containers
**Isolation**: Kata Containers (VM-level)
**Startup**: Variable
**Cost**: Usage-based

### Description

Managed platform with bring-your-own-cloud across AWS, GCP, Azure, and on-premise. Supports both CPU and GPU workloads. Full OCI container support.

### Integration Points

- Self-serve BYOC
- Kata Containers for VM-level isolation
- CPU and GPU workloads
- Full workload runtime beyond sandboxes

### Strengths

- BYOC (own cloud, their control plane)
- VM-level isolation via Kata
- GPU support

### Weaknesses

- Managed service (no self-hosted option)
- Less well-known
- No dev-specific features

### Best For

- Teams needing BYOC compliance
- GPU sandbox workloads

---

## Comparison Matrix

| Provider              | Isolation Model           | Startup Time | GPU        | Persistent Storage | Multi-Tenant | Self-Hostable | Cost Model    |
| --------------------- | ------------------------- | ------------ | ---------- | ------------------ | ------------ | ------------- | ------------- |
| **Local Docker**      | Container (shared kernel) | Seconds      | Host GPU   | Bind mounts        | No           | Yes           | Free          |
| **GitHub Codespaces** | VM                        | 5-60s        | No         | Yes (limited)      | Yes          | No            | Per-core-hour |
| **AWS EC2/ECS**       | VM/Container              | 10s-2min     | Yes        | EBS volumes        | Yes          | Yes           | Per-resource  |
| **Fly.io**            | Firecracker microVM       | 100ms-3s     | No         | Fly Volumes        | Yes          | No            | Usage-based   |
| **Modal**             | gVisor container          | Sub-second   | Yes (H100) | Ephemeral          | Yes          | No            | Pay-per-sec   |
| **Kubernetes**        | Container/Kata            | 5-30s        | Yes        | PVCs               | Yes          | Yes           | Node costs    |
| **E2B**               | Firecracker microVM       | ~200ms       | No         | Ephemeral          | Yes          | Enterprise    | Usage-based   |
| **Northflank**        | Kata containers           | Variable     | Yes        | Yes                | Yes          | BYOC          | Usage-based   |

## Recommendations for Sandbox Manager

1. **Start with local Docker as the primary target** -- it's universal, free, and has the lowest friction.
2. **Design a provider abstraction layer** (like DevPod's model) so plugins can target different backends without changing the user's config. **But build it after v1** -- design the interface by implementing a second provider, not in a vacuum.
3. **Prioritize Fly.io and Modal as cloud backends** (post-v1):
   - Fly.io for persistent, globally-distributed dev environments with scale-to-zero
   - Modal for ephemeral, GPU-capable sandboxes for AI/ML workflows
4. **Support for self-hosted Docker hosts** via SSH or Docker context -- this covers the "remote dev server" use case.
5. **Kubernetes support can come later** -- it adds significant complexity. If needed, target K3s for simplicity.
6. **Consider Firecracker for production isolation** -- it provides hardware-level isolation without full VM overhead.

### Important Caveats on Provider Abstraction

The provider abstraction will leak at:

- **Networking**: Fly.io Anycast vs Modal gVisor vs K8s CNI vs local bridge
- **Storage**: Fly Volumes vs Modal ephemeral vs K8s PVCs vs local bind mounts
- **Secrets**: Fly secrets vs Modal secrets vs K8s secrets vs Docker secrets
- **GPU access**: Modal H100/A100 vs K8s device plugins vs local NVIDIA runtime
- **Preview URLs**: Fly.io built-in vs local ngrok/Cloudflare Tunnel vs K8s Ingress

**Recommendation**: Implement local Docker provider fully in v1. Add Fly.io provider in v0.2 to validate the abstraction. Add Modal in v0.3. Each provider teaches you what the interface actually needs.

### Cloud Infrastructure Requirements

- Container registry for image storage and distribution
- Object storage (S3-compatible) for cache blobs and snapshots
- DNS for preview URLs
- Optional: VPC/network isolation for multi-tenant

### Architectural Recommendation

```
[User CLI/TUI] -> [Config (sandbox/ directory)] -> [Provider Plugin Interface]
                                               |
                           +-------------------+-------------------+
                           |                   |                   |
                     [Local Docker]     [Fly.io Plugin]    [Modal Plugin]
                           |                   |                   |
                     [Docker Engine]    [Firecracker VMs]   [gVisor Containers]
```

**v1 implements only the Local Docker column.** The interface is defined by what the second provider needs.
