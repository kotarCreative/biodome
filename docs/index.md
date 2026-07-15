# sandbox-manager

`sandbox-manager` is a development environment manager built around composable primitives. Instead of writing YAML or JSON, you describe your environment with small JavaScript files inside a `sandbox/` directory. Each file contributes capabilities — languages, services, packages, tools, processes, hooks — to a shared plan that the CLI turns into Docker images, containers, and compose files.

## Why code-based configuration?

- **Familiarity:** JavaScript is the most widely known authoring language.
- **Flexibility:** You can use conditionals, read files, run shell commands, and construct configs dynamically.
- **Composability:** Each file is a feature. You can combine them, group them, or share them between projects.
- **Extensibility:** If a built-in primitive does not cover your case, you can drop in a custom process or hook.

## Quick start

```bash
npx sandbox-manager init
npx sandbox-manager build
npx sandbox-manager up
```

## Concepts

- **Primitives:** The building blocks you add to a sandbox. `process`, `hook`, `language`, `package`, `tool`, `service`.
- **Plan:** The intermediate representation of your environment. Each feature contributes to it.
- **Features:** JavaScript modules in `sandbox/features/` that export a default function receiving the sandbox context.
- **Services:** Backing containers like Postgres or Redis, declared in `sandbox/services.mjs`.

## Documentation

- [File layout](file-layout.md)
- [Primitives](primitives.md)
- [Processes and hooks](processes.md)
- [API reference](api.md)
- [Examples](examples.md)
