# Roadmap

`sandbox-manager` is a TypeScript/Node CLI that turns a `sandbox/` directory into a reproducible Docker development environment.

## Current state

- `sandbox init` scaffolds `sandbox/config.json`, `sandbox/services.js`, and `sandbox/features/*.js`.
- `sandbox build` / `up` / `down` / `exec` manage the generated Docker environment.
- `sandbox info` and `sandbox generate agents.md` produce project summaries from the computed plan.
- `sandbox config validate` checks `sandbox/config.json` schema without executing feature scripts.
- Feature files are plain ESM modules that export a default function receiving a typed `SandboxContext`.
- Dockerfile, `docker-compose.yaml`, `.dockerignore`, and `supervisord.conf` are generated from the plan.

## Known gaps

- No integration tests: generated images and compose files are not exercised in CI.
- No `.github/workflows` yet.
- Service support is limited to Postgres and Redis; custom images are treated as generic containers.
- Only one base image per project is supported; mixing languages emits a warning.

## Next steps

1. Add a GitHub Actions workflow that builds the generated Dockerfile for a fixture project.
2. Expand integration tests to run `docker compose up` and assert services become healthy.
3. Add validation for feature module exports and service configuration.
4. Document the feature module API and the available language handlers.
