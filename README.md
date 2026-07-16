# Biodome

Self-contained development environments powered by composable JavaScript primitives.

See the [docs](docs/index.md) for full documentation.

## Quick start

```bash
npx @kotarcreative/biodome init
npx @kotarcreative/biodome build
npx @kotarcreative/biodome up
npx @kotarcreative/biodome info
```

## Commands

- `biodome init [--bare]` — create a `biodome/` directory with language auto-detection; `--bare` creates a minimal scaffold.
- `biodome build` — generate Docker files and build the dev image.
- `biodome up` — start the dev container and backing services.
- `biodome down` — stop the environment.
- `biodome exec <command>` — run a command inside the dev container.
- `biodome info` — show services, ports, and connection strings.
- `biodome config validate` — validate `biodome/`, feature/service module exports, and the computed plan (including port conflicts) without building.
- `biodome generate agents.md` — create `AGENTS.md` for AI context.
- `biodome logs [process]` — tail logs from a managed process.
- `biodome ps` — show running containers for the project.
- `biodome status` — report container health and running managed processes.
- `biodome restart [process]` — restart a managed process or all daemons.

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
