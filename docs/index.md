# Biodome

Biodome creates development environments from small JavaScript files inside `.biodome/`. Declare languages, services, packages, tools, processes, and hooks; Biodome derives the image and startup configuration. External agents can invoke ordinary command actions with explicit intent, JSON input, and output files. Biodome does not install agents or manage their workflows.

## Why code-based configuration?

- **Familiarity:** JavaScript is the most widely known authoring language.
- **Flexibility:** You can use conditionals, read files, run shell commands, and construct configs dynamically.
- **Composability:** Each file is a feature. You can combine them, group them, or share them between projects.
- **Extensibility:** If a built-in primitive does not cover your case, you can drop in a custom process or hook.

## Quick start

```bash
npx @kotarcreative/biodome init
npx @kotarcreative/biodome build local
npx @kotarcreative/biodome up local
```

`init` auto-detects languages from project files (`package.json`, `bun.lockb`, `requirements.txt`, `composer.json`, `go.mod`, etc.) and generates a starter `.biodome/features/auto-detect.mjs` feature. To skip this and create a minimal scaffold, pass `--bare`.

## Concepts

- **Primitives:** The building blocks you add to a biodome. `process`, `hook`, `language`, `package`, `tool`, `service`.
- **Plan:** The intermediate representation of your environment. Each feature contributes to it.
- **Applications:** Implicit modules in `.biodome/apps/` that expand a local app or npm-distributed recipe into ordinary primitives.
- **Features:** JavaScript modules in `.biodome/features/` that export a default function receiving the biodome context and extend the base plan after applications.
- **Services:** Backing dependencies declared in `.biodome/services.mjs`. Built-in Postgres and Redis run ephemerally as supervised processes inside the dev container.
- **Actions:** On-demand command hooks in `.biodome/actions/`, with input, intent, outputs, timeout, and cleanup policy. See [Environment actions](actions.md).
- **Profiles:** Named feature selections and environment overrides in `.biodome/profiles/`, selected with `--profile`. See [Environment profiles](profiles.md).

## MCP (Model Context Protocol)

Biodome can serve an MCP endpoint that exposes sandbox information, process logs, service health, and action tools to AI agents. Enable it by adding `"mcp": { "enabled": true }` to your `.biodome/config.json`. See [Processes and hooks](processes.md#built-in-mcp-server) for details.

```bash
biodome config validate  # confirm the config is valid
biodome up local         # starts the local target + MCP server
```

## Event capture

Every lifecycle command (`build`, `up`, `down`, `exec`, `restart`, `status`, `ps`, `logs`, `config validate`) captures a structured, append-only event log by default. Target-scoped commands write to `.biodome-build/targets/<target>/logs/events-<runId>.jsonl`; target-less commands write to `.biodome-build/logs/events-<runId>.jsonl`. Pass `--no-events` to disable. Events include every plan load, generated file, hook, and runtime operation with timing. Files rotate before exceeding 10 MB, and each log directory retains its newest 100 event files.

```bash
biodome build local
biodome --no-events build local
biodome events
biodome events --run <runId>
biodome events --limit 50
```

Queries return at most 100 events by default and accept up to 1,000 with `--limit`. Run-filtered queries address only the matching run files; unfiltered queries also read rotated segments of the newest files. If a historical JSONL line is malformed, the command reports its filename and line number while returning valid events from other lines.

## Documentation

- [File layout](file-layout.md)
- [Applications and app recipes](apps.md)
- [Computer-use recipe](recipes/computer-use.md)
- [Deploying to AWS ECS](aws-ecs.md)
- [Primitives](primitives.md)
- [Processes and hooks](processes.md)
- [API reference](api.md)
- [Examples](examples.md)
- [Environment actions and branch sessions](actions.md)
- [Named environment profiles](profiles.md)
- [Active design and implementation plans](design/README.md)
