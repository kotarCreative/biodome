# Plan 04: Isolate Container Processes

Status: proposed. Priority: P1. Dependencies: Plans 01 and 02.

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
