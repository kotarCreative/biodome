# Plan 04: Isolate Container Processes

Status: complete (implemented 2026-08). Priority: P1. Dependencies: Plans 01 and 02.

## Resolution Notes

- Generated images create three non-root identities with stable uid/gid
  defaults: runtime `biodome` (10001), MCP `biodome-mcp` (10002), and mount
  helper `biodome-mount` (10003). The MCP and mount users join the runtime
  group for shared read access to the generated tree and supervisor socket.
  Creation falls back to busybox `addgroup`/`adduser` on alpine-style bases.
- The startup script maps the runtime identity onto the workspace bind-mount
  owner via `BIODOME_RUNTIME_UID` / `BIODOME_RUNTIME_GID`. Local Compose flows
  default the mapping to the invoking non-root host user. Ordinary base-image
  accounts (for example `node` at UID 1000) may alias that host identity;
  mapping to root or to another isolated Biodome/service identity is rejected.
  Mapping fails closed when the image cannot perform it, rather than leaving
  supervisor, hooks, cache ownership, and exec on different numeric identities.
  Access for non-root identities is
  granted with mode changes only (`a+rX` on the generated tree including its
  0700 ancestors, group-shared writable state for logs and harness homes) —
  never a recursive chown of source files. Only declared managed dependency
  caches receive recursive, symlink-safe ownership repair.
- Local Compose and Docker Sandbox `exec`/actions select the plan's named
  runtime user explicitly, including its HOME and workspace. Timeout enforcement
  occurs inside the workload container. Root remains reserved for initialization
  and infrastructure controls, not user commands.
- Command-only environments also perform identity initialization. Aggregate
  health checks require the startup readiness marker before a target is reusable.
- Supervisor stops and kills the complete process group, so restarting launchers
  such as npm cannot leave orphaned children holding application ports. Managed
  Biodome identities receive their own HOME instead of inheriting `/root`.
- Process environments are scoped by default; sharing with the global runtime
  environment requires `mergeEnv: true`.
- Supervisor assigns explicit `user=` per program category: user workloads run
  as `biodome`, MCP as `biodome-mcp`, rclone helpers as `biodome-mount`,
  in-container Postgres as its package-created `postgres` system user (scripts
  no longer use `su`), and only biodome health monitors stay root so they can
  restart programs through the socket (`chmod=0770`, group-owned).
- FUSE sidecar evaluation: a dedicated sidecar with shared mount propagation
  still requires elevated privileges somewhere in the trust chain without
  providing a defensible boundary for local Compose, so direct mounts remain
  available only as the explicitly unsafe opt-in below rather than via sidecar.
- Direct in-container FUSE mounts require `directMount: true`; validation
  rejects them otherwise (both at build time and in `validatePlan`) and emits a
  deterministic residual-risk warning when enabled.
- `--allow-other` was removed unconditionally; no tested workflow needed it, so
  no typed option exists.
- Hooks run under `setpriv` as the mapped runtime identity (failing closed
  where setpriv is unavailable); lifecycle init stays
  root-only inside the generated startup script.
- Language runtimes moved out of `/root` so non-root users can execute them:
  pyenv installs to `/opt/pyenv`; rustup uses `/usr/local/rustup` and
  `/usr/local/cargo`.
- Docker Sandboxes consume the same rendered image and startup script; their
  start flow maps the runtime identity onto the snapshot owner inside the
  sandbox.
- Plan 05 consumes `plan.runtime.identities` as the provider-neutral
  runtime-user requirement for ECS task definitions.

## Objective

Run user-controlled development and agent processes without root privileges, confine
credentials to the processes that require them, and make direct FUSE mounts an
explicit high-risk exception rather than a default convenience.

## Current Baseline

- Generated Compose services no longer use `privileged: true`.
- Direct cloud mounts receive `/dev/fuse`, `SYS_ADMIN`, dropped capabilities, and
  `no-new-privileges`.
- The generated image has no final non-root `USER`.
- Supervisor and its programs run as root unless a program says otherwise.
- Direct rclone mounts always use `--allow-other`.
- Workspace bind-mount ownership depends on the host.

## Locked Decisions

- User-defined processes and agent harnesses never run as root by default.
- Use stable generated runtime identities with explicit UID/GID configuration.
- Supervisor may start with elevated privileges only to initialize and drop to named
  users; it must not make user workloads root.
- MCP and mount helpers receive only their required credentials and identities.
- Proxy volumes remain the recommended cloud-volume mode.
- Direct FUSE mounts require explicit opt-in, a validation warning, and a documented
  residual-risk acknowledgement.
- Do not describe `SYS_ADMIN` as safe isolation. If a sidecar cannot provide a
  defensible boundary, retain direct mounts only as an explicitly unsafe mode or
  remove them.
- `--allow-other` is disabled unless a separate explicit option requires it.

## Files

- `src/core/plan.ts`
- `src/core/plan-builder/processes.ts`
- `src/core/plan-builder/volumes.ts`
- `src/docker/generators/dockerfile.ts`
- `src/docker/generators/compose.ts`
- `src/docker/generators/supervisor.ts`
- `src/docker/generators/healthchecks.ts`
- Docker Sandbox rendering and runtime files
- Generator and Docker integration tests

## Implementation Steps

1. Add a generated runtime-user configuration with validated UID and GID defaults.
2. Create the runtime, MCP, and mount-helper identities and required groups in the
   generated image.
3. Assign ownership only to workspace, home, cache, logs, and generated runtime paths
   each identity needs.
4. Set explicit supervisor `user=` values for every generated program category.
5. Ensure process environment generation does not merge unrelated volume, provider,
   MCP, or harness credentials.
6. Make workspace ownership work for bind mounts without recursively changing an
   arbitrary host repository. Use configurable UID/GID mapping or a narrowly scoped
   startup fixup.
7. Evaluate a dedicated FUSE sidecar and shared mount for Compose.
8. If direct in-container FUSE remains, require explicit opt-in and expose its
   `SYS_ADMIN` risk during validation.
9. Remove unconditional `--allow-other`; add a typed option only if a tested workflow
   needs it.
10. Apply equivalent non-root identity and writable-path rules to Docker Sandboxes.
11. Add a provider-neutral runtime-user requirement for Plan 05 to consume on ECS.

## Required Tests

- Generated Dockerfiles and runtime definitions select a non-root workload user.
- Supervisor programs use the intended identity and no user workload uses root.
- MCP, provider, volume, and harness credentials appear only in intended process
  environments.
- Proxy volumes require no FUSE device or capability.
- Direct mounts are rejected without explicit opt-in and emit a deterministic warning
  when enabled.
- `--allow-other` is absent by default.
- Integration tests verify workspace read/write, package caches, health checks,
  harness wrappers, and normal commands as a non-root effective UID.

## Acceptance Criteria

- A normal generated development environment has no root user-controlled process.
- Generated Compose files never use `privileged: true`.
- Credential environments are scoped per process rather than inherited globally.
- Direct cloud mounts cannot be enabled accidentally or without a visible risk
  decision.
- Compose and Docker Sandbox integration workflows remain usable with non-root
  identities.

## Verification

```bash
npm run test:run -- src/tests/docker/generators
npm run test:run -- src/tests/core/plan-builder/volumes.test.ts
npm run check
npm run build
npm run test:integration
```
