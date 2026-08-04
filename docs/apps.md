# Applications and app recipes

Applications make conventional project setup concise while preserving Biodome's
portable primitives. Every immediate `.mjs` or `.js` file in `.biodome/apps/`
defines one application. Its filename is its identity: `backend.mjs` defines
`backend`; an app cannot override that name.

```text
.biodome/
  services.mjs
  apps/
    backend.mjs
    frontend.mjs
  lib/
    company-api.mjs
  features/
    smoke-data.mjs
```

Apps are loaded after `services.mjs` and before low-level features. Biodome first
discovers every app, resolves cross-app dependencies, then expands them in a
deterministic dependency-first order. This means a frontend can depend on a
backend endpoint regardless of filename ordering.

## Local apps

An app file may default-export a function that receives an application-scoped
builder. Contributions are automatically namespaced and use
`/workspace/apps/<app-name>` as their default root.

```javascript
// .biodome/apps/backend.mjs
export default function backend(app) {
  app.addLanguage("python", { version: "3.12" });
  app.addRepository({ url: "git@github.com:acme/backend.git" });
  app.requireService("postgres");
  app.addHook("migrate", {
    command: ["python", "manage.py", "migrate"],
    startOn: "start.pre",
  });
  app.addProcess("web", {
    command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
    port: 8000,
  });
  app.exposeEndpoint("http", { process: "web" });
}
```

The resulting primitive names are `backend:migrate`, `backend:web`, and
`backend:http`. The repository defaults to the name `backend` and path
`/workspace/apps/backend`.

Put reusable local helpers in `.biodome/lib/` and import them explicitly.
`lib/` is never scanned or executed automatically.

## Distributed recipes

An npm package can export a recipe using the public subpath API:

```javascript
import { defineAppRecipe } from "@kotarcreative/biodome/app";

export const django = defineAppRecipe({
  id: "@acme/biodome-app-django",
  version: "1.2.3",
  apiVersion: 1,
  expand(app, options) {
    app.addRepository({ url: options.repo });
    app.requireService(options.database);
    app.addProcess("web", {
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      port: 8000,
    });
    app.exposeEndpoint("http", { process: "web" });
  },
});
```

Recipes published through npm should provide their package version. Biodome
records it with the expanded application and every contributed primitive, so
plan inspection and plan digests identify the exact recipe release. Local
recipes may omit the version.

Use it from an implicit app entrypoint:

```javascript
import { django } from "@acme/biodome-app-django";

export default django({
  repo: "git@github.com:acme/backend.git",
  database: "postgres",
});
```

Install recipes into the isolated `.biodome` package manifest:

```bash
biodome app add @acme/biodome-app-django --yes
```

This creates or updates `.biodome/package.json` and its lockfile. Commit those
files. `.biodome/node_modules/` is ignored. Biodome never installs missing
recipes while planning, building, or running.

App modules and recipe packages are trusted host-side JavaScript, just like
features. Review and pin them as normal development dependencies; they are not
sandboxed during plan construction.

## References and dependencies

Use serializable references instead of hard-coded provider topology:

```javascript
import { app, service } from "@kotarcreative/biodome/app";

export const dependsOn = ["backend"];

export default function frontend(application) {
  application.requireService(service("postgres"));
  application.requireAppEndpoint(app("backend").endpoint("http"));
  application.addProcess("web", { command: ["node", "server.mjs"], port: 4200 });
  application.exposeEndpoint("http", { process: "web" });
}
```

Recipe options are inspected for `app("backend").endpoint("http")` references.
For imperative local apps, export `dependsOn` to establish expansion ordering.
Missing apps and dependency cycles fail before any app is expanded.

## Inspecting applications

```bash
biodome app validate
biodome app list
biodome app inspect backend
biodome app inspect backend --json
```

`inspect` shows the app root, declaration, recipe identity, service and app
dependencies, expanded primitives, and provenance. Low-level files in
`.biodome/features/` remain supported and load after apps, so they are the
right place to extend app-generated behavior for a project-specific edge case.
