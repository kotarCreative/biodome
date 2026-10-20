# Biodome

Development environments from small, composable files. Declare languages,
services, applications, and hooks; Biodome generates the image and startup
configuration. External agents can invoke commands with explicit intent, JSON
input, and expected output files—without installing an agent in the container.

Targets select Docker Compose, Docker Sandboxes, or AWS ECS. AWS ECS remains
experimental until its credentialed live acceptance workflow passes.

See the [docs](docs/index.md) for full documentation.

## Quick start

```bash
npx @kotarcreative/biodome init
npx @kotarcreative/biodome build local
npx @kotarcreative/biodome up local
npx @kotarcreative/biodome info
npx @kotarcreative/biodome shell local
npx @kotarcreative/biodome down local
```

## Commands

- `biodome init [--bare]` — create a `.biodome/` directory with language auto-detection and a default `local` target; `--bare` creates a minimal scaffold.
- `biodome build <target>` — render and build a named target.
- `biodome up <target>` — start a named target.
- `biodome down <target>` — stop a named target.
- `biodome exec <target> <command...>` — run a command inside a target.
- `biodome shell <target>` — open an interactive shell in a running Compose environment.
- `biodome plan <target> <action> [--json]` — inspect an action and preflight provider requirements without starting anything.
- `biodome run <target> <action> [--input <json>] [--intent <text>] [--output <paths...>] [--json]` — run an ordinary command hook and collect its outputs.
- `biodome info` — show services, ports, and connection strings.
- `biodome app list` — list implicit applications declared in `.biodome/apps/`.
- `biodome app inspect <name> [--json]` — show an app's expanded primitives and provenance.
- `biodome app validate` — validate implicit apps, references, features, and the final plan.
- `biodome app add <package> --yes` / `app remove <package>` — manage trusted npm app recipes in `.biodome/package.json`.
- `biodome config validate` — validate `.biodome/`, feature/service module exports, and the computed plan (including port conflicts) without building.
- `biodome config env [target]` — interactively collect environment variables required by targets and save them to `.biodome/.env`.
- `biodome target validate <target>` — validate a named target configuration without building or deploying.
- `biodome generate agents.md` — create `AGENTS.md` for AI context.
- `biodome logs <target> [process]` — show logs from a managed process when the target supports log access.
- `biodome ps <target>` — show the target status.
- `biodome status <target>` — report target health and, when supported, managed-process status.
- `biodome restart <target> [process]` — restart a managed process or all daemons when supported by the target.
- `biodome events [--run <runId>] [--limit <n>]` — show a bounded set of captured structured events from previous runs.

Every lifecycle command captures a structured event stream by default. Target-scoped commands write to `.biodome-build/targets/<target>/logs/events-<runId>.jsonl`; target-less commands write to `.biodome-build/logs/events-<runId>.jsonl`. Pass `--no-events` to disable. Event files rotate before exceeding 10 MB and retain the newest 100 files per log directory. `biodome events` returns up to 100 valid events by default (at most 1,000); malformed JSONL lines are reported with their filename and line number while other events remain available.

## Documentation

- [Overview](docs/index.md)
- [File layout](docs/file-layout.md)
- [Applications and recipes](docs/apps.md)
- [Computer-use recipe](docs/recipes/computer-use.md)
- [Deploying to AWS ECS](docs/aws-ecs.md)
- [Primitives](docs/primitives.md)
- [Processes and hooks](docs/processes.md)
- [API reference](docs/api.md)
- [Examples](docs/examples.md)
- [Actions, branch QA, performance tests, and interactive sessions](docs/actions.md)

## An action, not an agent workflow

```javascript
// .biodome/actions/e2e.mjs
export default function e2e(ctx) {
  ctx.addAction({
    command: ["node", "scripts/e2e.mjs"],
    intent: "Verify the checkout journey on this branch",
    input: { viewport: "desktop" },
    outputs: ["results/e2e.json"],
    cleanup: "always",
  });
}
```

The command reads `BIODOME_ACTION_INPUT` as JSON and writes the declared files.
The calling agent owns its prompts, models, and decisions. See the
[migration guide](docs/actions.md#migrating-from-embedded-agent-tasks) for the
removed harness-based APIs.

## Development

```bash
npm install
npm run typecheck
npm run test:run
npm run build
```
