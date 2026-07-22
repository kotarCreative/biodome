# Roadmap

Biodome is a TypeScript/Node CLI that turns a `.biodome/` directory into a reproducible Docker development environment.

## Current state

- `biodome init` scaffolds `.biodome/config.json`, `.biodome/services.mjs`, `.biodome/features/*.mjs`, a default `local` target, and a `tasks/` directory.
- `biodome build <target>` / `up <target>` / `down <target>` / `exec <target>` manage the generated Docker environment for a named deployment target.
- `biodome run <target> <task>` executes a named agent task against a target sandbox.
- `biodome target validate <target>` validates a named target configuration without building.
- `biodome info` and `biodome generate agents.md` produce project summaries from the computed plan.
- `biodome config validate` checks `.biodome/config.json` schema and feature/service module exports without executing feature scripts.
- Lifecycle commands now require a target name. Targets are user-defined files in `.biodome/targets/<name>.mjs`. The CLI has no provider-specific commands or reserved target names.
- Tasks are named action profiles in `.biodome/tasks/<name>.mjs` that declare a harness, prompt, timeout, artifact paths, and cleanup policy.
- Feature files are plain ESM modules that export a default function receiving a typed `SandboxContext`.
- Target and task files are plain ESM modules that receive narrow `TargetContext` or `TaskContext` interfaces. A target may only call `useRuntime()`; a task may only call `addTask()`.
- A runtime driver registry selects a backend by driver ID. Built-in drivers include `docker-compose` (full implementation) and `aws-ecs` (stub; implementation in progress).
- Generated artifacts, state, and event logs are target-scoped under `.biodome-build/targets/<target>/`.
- Dockerfile, `docker-compose.yaml`, `.dockerignore`, `supervisord.conf`, and per-process health check scripts are generated from the plan and written to the target output directory.
- Integration tests assert generated images build for Python, Node, and Go, that a Postgres service becomes healthy, and that a daemon process becomes healthy and is monitored by `supervisord`.
- Agent harnesses are available for OpenCode (`addOpencodeHarness`), Pi (`addPiHarness`), Codex (`addCodexHarness`), and Claude Code (`addClaudeHarness`), each producing an isolated home directory, config files, lifecycle hooks for telemetry, and a daemon process with health checks.

## Known gaps

- Service support is limited to Postgres and Redis; custom images are treated as generic containers.

- Java has only a base image; Maven/Gradle dependency handling is not implemented.
- `addPackage` always installs globally, which is awkward for language-specific project dependencies.
- There is no built-in support for `.env` files, secrets, or bind-mount volumes.

## Completed roadmap items

1. ~~Expand integration tests to assert services become healthy and exercise more languages.~~ Done — Postgres health and Go, Node, and Python builds are now asserted.
2. ~~Add validation for feature module exports and service configuration.~~ Done — `biodome config validate` now checks that `services.mjs`/`.js` and every feature module exports a default function. The default functions are not invoked, though ESM top-level code still runs during import.
3. ~~Document the feature module API and the available language handlers.~~ Done — `docs/primitives.md`, `docs/api.md`, `docs/examples.md`, and `docs/file-layout.md` cover the API, primitives, file layout, and examples.
4. ~~Per-process health checks in `supervisord`.~~ Done — each daemon process with a health check now gets a generated check script and a `supervisord` monitor program that restarts the process after repeated failures. The dev service health check now aggregates all daemon checks, and `supervisorctl` is configured to use the generated `supervisord.conf`.
5. ~~Multi-language / multi-base-image support.~~ Done — multiple `addLanguage` calls now install all requested runtimes on a shared `debian:12-slim` base image, enabling Python + Node, Go + Rust, or any other combination in a single container.
6. ~~CLI polish.~~ Done — `biodome init` now auto-detects languages and generates a starter `.biodome/features/auto-detect.mjs` feature by default, `biodome status` reports container health and running processes, and `biodome config validate` runs `validatePlan` to catch port conflicts without building.
7. ~~Headless agent harnesses for Codex and Claude Code.~~ Done — Added `addCodexHarness` and `addClaudeHarness` primitives alongside the existing OpenCode and Pi harnesses. Each generates isolated home directories, config files (TOML/JSON), lifecycle hooks for correlated telemetry, and daemon processes with TCP health checks. Codex uses `codex exec-server` with `approval_policy = "never"`; Claude uses a wrapper script and `claude -p` with configurable tools and permissions.
8. ~~Security, performance, and ergonomics hardening.~~ Done — All 12 tasks from the [implementation plan](design/security-performance-ergonomics-plan.md) are complete:
   - Fast linter/formatter toolchain (oxlint/oxfmt) with CI quality gates.
   - Production dependency audit: high-severity `fast-uri` fixed, remaining 7 moderate findings documented.
   - MCP authentication: bearer token via `timingSafeEqual`, loopback-only listener, gated `exec_command`/`restart_process` tools, configurable size limits.
   - Telemetry hardening: secrets and payloads excluded from default logs; credential-bearing APIs reject literal strings (require `{ env: "VAR" }`).
   - Local proxy volume containment: `path.resolve()`, realpath/symlink checks, deny-all default for `allowedPaths`.
   - S3 adapter pagination via continuation tokens; adapter client caching.
   - Container privilege reduction: cloud volumes use `/dev/fuse` + `SYS_ADMIN` + `no-new-privileges` instead of `privileged: true`.
   - Repo sync hardening: SSH uses `StrictHostKeyChecking=yes` with a dedicated known-hosts file.
   - Non-blocking MCP I/O: `execSync`/`execFileSync` replaced with async `exec`/`execFile`.
   - Event storage bounded at 10 MB default max file size.
9. ~~Named deployment targets and tasks.~~ Done — Targets and tasks are user-defined files, CLI commands accept target names, lifecycle operations are target-scoped, a driver registry selects the runtime backend, and the Docker Compose driver produces target-scoped artifacts.:
   - Fast linter/formatter toolchain (oxlint/oxfmt) with CI quality gates.
   - Production dependency audit: high-severity `fast-uri` fixed, remaining 7 moderate findings documented.
   - MCP authentication: bearer token via `timingSafeEqual`, loopback-only listener, gated `exec_command`/`restart_process` tools, configurable size limits.
   - Telemetry hardening: secrets and payloads excluded from default logs; credential-bearing APIs reject literal strings (require `{ env: "VAR" }`).
   - Local proxy volume containment: `path.resolve()`, realpath/symlink checks, deny-all default for `allowedPaths`.
   - S3 adapter pagination via continuation tokens; adapter client caching.
   - Container privilege reduction: cloud volumes use `/dev/fuse` + `SYS_ADMIN` + `no-new-privileges` instead of `privileged: true`.
   - Repo sync hardening: SSH uses `StrictHostKeyChecking=yes` with a dedicated known-hosts file.
   - Non-blocking MCP I/O: `execSync`/`execFileSync` replaced with async `exec`/`execFile`.
   - Event storage bounded at 10 MB default max file size.

## Next steps

1. **Implement AWS ECS/Fargate driver** — Complete the `aws-ecs` driver stub: build and push images to ECR, register task definitions, run Fargate tasks, stream CloudWatch logs, and implement task stop/status. Target configuration declares region, cluster, repository, network, and IAM role references.

2. **Named task execution and artifact collection** — Wire the `biodome run` command through the task runner: construct harness commands, stream agent output, collect declared artifacts from the sandbox, and apply cleanup policy. Add artifact collection for the Docker driver via `docker cp`.

3. **Target-scoped event logging** — Include `target` and `driver` fields in all lifecycle event payloads, and separate event stores per target.

4. **More built-in services** — Add handlers for common backing services (e.g. MySQL/MariaDB, MongoDB, RabbitMQ, Kafka, Elasticsearch). Each handler should set the correct image, environment, volumes, and health check, and update `serviceConnection` in `src/core/info.ts` so `biodome info` prints connection strings.

5. **Java dependency handling** — Implement Maven (`pom.xml`) and Gradle (`build.gradle[.kts]`) dependency installation in `src/core/languages.ts`, including dependency-file detection and artifact copying. Add an integration test that builds a Java project.

6. **Integration test matrix** — Add integration tests for Rust and targets (build/starts with two differently-named local targets yield distinct Compose project names and output directories).

7. **Improve `addPackage` semantics** — Decide and document whether `addPackage` is for global tooling or project dependencies; for project dependencies, install them into the same virtual environment / `node_modules` / target directory used by the language handler rather than globally.

8. **Volumes, bind mounts, and secrets** — Add primitives for named volumes, bind mounts, tmpfs mounts, and `.env`/secret injection so feature files can declare data directories and sensitive configuration.
