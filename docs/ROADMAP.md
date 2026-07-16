# Roadmap

`sandbox-manager` is a TypeScript/Node CLI that turns a `sandbox/` directory into a reproducible Docker development environment.

## Current state

- `sandbox init` scaffolds `sandbox/config.json`, `sandbox/services.mjs`, and `sandbox/features/*.mjs` (legacy `.js` extensions are also supported).
- `sandbox build` / `up` / `down` / `exec` manage the generated Docker environment.
- `sandbox info` and `sandbox generate agents.md` produce project summaries from the computed plan.
- `sandbox config validate` checks `sandbox/config.json` schema and feature/service module exports without executing feature scripts.
- Feature files are plain ESM modules that export a default function receiving a typed `SandboxContext`.
- Dockerfile, `docker-compose.yaml`, `.dockerignore`, `supervisord.conf`, and per-process health check scripts are generated from the plan.
- Integration tests assert generated images build for Python, Node, and Go, that a Postgres service becomes healthy, and that a daemon process becomes healthy and is monitored by `supervisord`.

## Known gaps

- Service support is limited to Postgres and Redis; custom images are treated as generic containers.

- Java has only a base image; Maven/Gradle dependency handling is not implemented.
- `addPackage` always installs globally, which is awkward for language-specific project dependencies.
- There is no built-in support for `.env` files, secrets, or bind-mount volumes.

## Completed roadmap items

1. ~~Expand integration tests to assert services become healthy and exercise more languages.~~ Done — Postgres health and Go, Node, and Python builds are now asserted.
2. ~~Add validation for feature module exports and service configuration.~~ Done — `sandbox config validate` now checks that `services.mjs`/`.js` and every feature module exports a default function. The default functions are not invoked, though ESM top-level code still runs during import.
3. ~~Document the feature module API and the available language handlers.~~ Done — `docs/primitives.md`, `docs/api.md`, `docs/examples.md`, and `docs/file-layout.md` cover the API, primitives, file layout, and examples.
4. ~~Per-process health checks in `supervisord`.~~ Done — each daemon process with a health check now gets a generated check script and a `supervisord` monitor program that restarts the process after repeated failures. The dev service health check now aggregates all daemon checks, and `supervisorctl` is configured to use the generated `supervisord.conf`.
5. ~~Multi-language / multi-base-image support.~~ Done — multiple `addLanguage` calls now install all requested runtimes on a shared `debian:12-slim` base image, enabling Python + Node, Go + Rust, or any other combination in a single container.

## Next steps

1. **More built-in services** — Add handlers for common backing services (e.g. MySQL/MariaDB, MongoDB, RabbitMQ, Kafka, Elasticsearch). Each handler should set the correct image, environment, volumes, and health check, and update `serviceConnection` in `src/core/info.ts` so `sandbox info` prints connection strings.

2. **Java dependency handling** — Implement Maven (`pom.xml`) and Gradle (`build.gradle[.kts]`) dependency installation in `src/core/languages.ts`, including dependency-file detection and artifact copying. Add an integration test that builds a Java project.

3. **Integration test matrix** — Add integration tests for Rust and the new services, and assert that daemon processes start and their health checks pass inside a running container.

4. **Improve `addPackage` semantics** — Decide and document whether `addPackage` is for global tooling or project dependencies; for project dependencies, install them into the same virtual environment / `node_modules` / target directory used by the language handler rather than globally.

5. **Volumes, bind mounts, and secrets** — Add primitives for named volumes, bind mounts, tmpfs mounts, and `.env`/secret injection so feature files can declare data directories and sensitive configuration.

6. **CLI polish** —
   - Make `sandbox init` optionally generate a starter feature (e.g. language auto-detection).
   - Add a `sandbox status` command that reports container health and running processes.
   - Run `validatePlan` during `sandbox config validate` so port conflicts are caught without building.

7. **Documentation** — Add a troubleshooting guide and a "creating custom services" guide once the service-handler interface stabilizes.
