# Roadmap

`sandbox-manager` is a TypeScript/Node CLI that turns a `sandbox/` directory into a reproducible Docker development environment.

## Current state

- `sandbox init` scaffolds `sandbox/config.json`, `sandbox/services.mjs`, and `sandbox/features/*.mjs` (legacy `.js` extensions are also supported).
- `sandbox build` / `up` / `down` / `exec` manage the generated Docker environment.
- `sandbox info` and `sandbox generate agents.md` produce project summaries from the computed plan.
- `sandbox config validate` checks `sandbox/config.json` schema without executing feature scripts.
- Feature files are plain ESM modules that export a default function receiving a typed `SandboxContext`.
- Dockerfile, `docker-compose.yaml`, `.dockerignore`, and `supervisord.conf` are generated from the plan.

## Known gaps

- Service support is limited to Postgres and Redis; custom images are treated as generic containers.
- Only one base image per project is supported; mixing languages emits a warning.
- Java has only a base image; Maven/Gradle dependency handling is not implemented.
- Only the first daemon health check is wired to the compose dev service; `supervisord` entries do not run their own health probes.

## Next steps

1. Expand integration tests to assert services become healthy and exercise more languages.
2. Add validation for feature module exports and service configuration.
3. Document the feature module API and the available language handlers.
