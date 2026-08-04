# Biodome

Portable, repository-defined tasks for coding agents. Biodome compiles the
environment, application services, task, agent harness, artifacts, and cleanup
policy into a provider-neutral execution plan. A target selects where that plan
runs: Docker Compose, Docker Sandboxes, AWS ECS, or a future provider.

See the [docs](docs/index.md) for full documentation.

## Quick start

```bash
npx @kotarcreative/biodome init
npx @kotarcreative/biodome build local
npx @kotarcreative/biodome up local
npx @kotarcreative/biodome info
npx @kotarcreative/biodome down local
```

## Commands

- `biodome init [--bare]` — create a `.biodome/` directory with language auto-detection and a default `local` target; `--bare` creates a minimal scaffold.
- `biodome build <target>` — render and build a named target.
- `biodome up <target>` — start a named target.
- `biodome down <target>` — stop a named target.
- `biodome exec <target> <command...>` — run a command inside a target.
- `biodome plan <target> <task> [--json]` — compile the portable execution plan and preflight it against the selected provider without starting anything.
- `biodome run <target> <task>` — execute a named task (e.g. `review-pr`) against a target.
- `biodome info` — show services, ports, and connection strings.
- `biodome config validate` — validate `.biodome/`, feature/service module exports, and the computed plan (including port conflicts) without building.
- `biodome target validate <target>` — validate a named target configuration without building or deploying.
- `biodome generate agents.md` — create `AGENTS.md` for AI context.
- `biodome logs <target> [process]` — tail logs from a managed process.
- `biodome ps <target>` — show the target status.
- `biodome status <target>` — report target health and running managed processes.
- `biodome restart <target> [process]` — restart a managed process or all daemons.
- `biodome events [--run <runId>]` — show captured structured events from previous runs.

Every lifecycle command captures a structured event stream to `.biodome-build/logs/events-<runId>.jsonl` by default. Pass `--no-events` to disable. This makes every plan load, hook, and runtime operation observable and reproducible.

## Documentation

- [Overview](docs/index.md)
- [File layout](docs/file-layout.md)
- [Primitives](docs/primitives.md)
- [Processes and hooks](docs/processes.md)
- [API reference](docs/api.md)
- [Examples](docs/examples.md)
- [Agent task orchestration](docs/orchestration.md)

## Development

```bash
npm install
npm run typecheck
npm run test:run
npm run build
```
