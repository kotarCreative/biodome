# Biodome

Self-contained development environments powered by composable JavaScript primitives.

See the [docs](docs/index.md) for full documentation.

## Quick start

```bash
npx @kotarcreative/biodome init
npx @kotarcreative/biodome build
npx @kotarcreative/biodome up
npx @kotarcreative/biodome info
npx @kotarcreative/biodome down
```

## Commands

- `biodome init [--bare]` — create a `.biodome/` directory with language auto-detection and a default `local` target; `--bare` creates a minimal scaffold.
- `biodome build` — render and build the local development sandbox.
- `biodome up` — start the local development sandbox.
- `biodome down` — stop the local development sandbox.
- `biodome exec <command>` — run a command inside the local development sandbox.
- `biodome run <target> <task>` — execute a named task (e.g. `review-pr`) against a target.
- `biodome info` — show services, ports, and connection strings.
- `biodome config validate` — validate `.biodome/`, feature/service module exports, and the computed plan (including port conflicts) without building.
- `biodome target validate <target>` — validate a named target configuration without building or deploying.
- `biodome generate agents.md` — create `AGENTS.md` for AI context.
- `biodome logs [process]` — tail logs from a managed process.
- `biodome ps` — show running containers for the project.
- `biodome status` — report container health and running managed processes.
- `biodome restart [process]` — restart a managed process or all daemons.
- `biodome events [--run <runId>]` — show captured structured events from previous runs.

Every lifecycle command captures a structured event stream to `.biodome-build/logs/events-<runId>.jsonl` by default. Pass `--no-events` to disable. This makes every plan load, hook, and runtime operation observable and reproducible.

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
