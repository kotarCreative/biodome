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

- `sandbox init` — create a `sandbox/` directory in the current project.
- `sandbox build` — generate Docker files and build the dev image.
- `sandbox up` — start the dev container and backing services.
- `sandbox down` — stop the environment.
- `sandbox exec <command>` — run a command inside the dev container.
- `sandbox info` — show services, ports, and connection strings.
- `sandbox config validate` — validate `sandbox/` without building.
- `sandbox generate agents.md` — create `AGENTS.md` for AI context.

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
