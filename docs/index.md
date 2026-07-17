# Biodome

Biodome is a development environment manager built around composable primitives. Instead of writing YAML or JSON, you describe your environment with small JavaScript files inside a `biodome/` directory. Each file contributes capabilities — languages, services, packages, tools, processes, hooks — to a shared plan that the CLI turns into Docker images, containers, and compose files.

## Why code-based configuration?

- **Familiarity:** JavaScript is the most widely known authoring language.
- **Flexibility:** You can use conditionals, read files, run shell commands, and construct configs dynamically.
- **Composability:** Each file is a feature. You can combine them, group them, or share them between projects.
- **Extensibility:** If a built-in primitive does not cover your case, you can drop in a custom process or hook.

## Quick start

```bash
npx @kotarcreative/biodome init
npx @kotarcreative/biodome build
npx @kotarcreative/biodome up
```

`init` auto-detects languages from project files (`package.json`, `bun.lockb`, `requirements.txt`, `composer.json`, `go.mod`, etc.) and generates a starter `biodome/features/auto-detect.mjs` feature. To skip this and create a minimal scaffold, pass `--bare`.

## Concepts

- **Primitives:** The building blocks you add to a biodome. `process`, `hook`, `language`, `package`, `tool`, `service`.
- **Plan:** The intermediate representation of your environment. Each feature contributes to it.
- **Features:** JavaScript modules in `biodome/features/` that export a default function receiving the biodome context.
- **Services:** Backing containers like Postgres or Redis, declared in `biodome/services.mjs`.

## MCP (Model Context Protocol)

Biodome can serve an MCP endpoint that exposes sandbox information, process logs, service health, and action tools to AI agents. Enable it by adding `"mcp": { "enabled": true }` to your `biodome/config.json`. See [Processes and hooks](processes.md#built-in-mcp-server) for details.

```bash
biodome config validate  # confirm the config is valid
biodome up               # starts dev container + MCP server
```

## Event capture

Every lifecycle command (`build`, `up`, `down`, `exec`, `restart`, `status`, `ps`, `logs`, `config validate`) captures a structured, append-only event log by default. Pass `--no-events` to disable. Events are written to `.biodome/logs/events-<runId>.jsonl` and include every plan load, generated file, hook, and runtime operation with timing.

```bash
biodome build
biodome --no-events build
biodome events
biodome events --run <runId>
```

This event stream lets you audit exactly what happened during a run and is designed to eventually support replaying a run step by step.

## Documentation

- [File layout](file-layout.md)
- [Primitives](primitives.md)
- [Processes and hooks](processes.md)
- [API reference](api.md)
- [Examples](examples.md)
