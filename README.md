# sandbox-manager

Development environment manager powered by composable JavaScript primitives.

See the [docs](docs/index.md) for full documentation.

## Quick start

```bash
npx sandbox-manager init
npx sandbox-manager build
npx sandbox-manager up
npx sandbox-manager info
```

## Commands

- `sandbox init [--bare]` — create a `sandbox/` directory with language auto-detection; `--bare` creates a minimal scaffold.
- `sandbox build` — generate Docker files and build the dev image.
- `sandbox up` — start the dev container and backing services.
- `sandbox down` — stop the environment.
- `sandbox exec <command>` — run a command inside the dev container.
- `sandbox info` — show services, ports, and connection strings.
- `sandbox config validate` — validate `sandbox/`, feature/service module exports, and the computed plan (including port conflicts) without building.
- `sandbox generate agents.md` — create `AGENTS.md` for AI context.
- `sandbox logs [process]` — tail logs from a managed process.
- `sandbox ps` — show running containers for the project.
- `sandbox status` — report container health and running managed processes.
- `sandbox restart [process]` — restart a managed process or all daemons.

## Documentation

- [Overview](docs/index.md)
- [File layout](docs/file-layout.md)
- [Primitives](docs/primitives.md)
- [Processes and hooks](docs/processes.md)
- [API reference](docs/api.md)
- [Examples](docs/examples.md)

## Development

```bash
npm install
npm run typecheck
npm run test:run
npm run build
```
