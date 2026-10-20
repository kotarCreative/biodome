# Processes and hooks

Declare long-running application processes with `addProcess()` and lifecycle
commands with `addHook()`:

```javascript
export default function application(ctx) {
  ctx.addProcess({
    name: "web",
    command: ["npm", "run", "dev"],
    port: 3000,
    healthCheck: { type: "http", url: "http://localhost:3000/health" },
  });
  ctx.addHook({
    name: "migrate",
    command: ["npm", "run", "migrate"],
    startOn: "start.pre",
    intent: "Apply migrations before serving the application",
    input: { database: "development" },
  });
}
```

Hooks optionally receive the [action input/output/intent contract](actions.md).
Processes are supervised, use scoped environments by default, and may declare
`workingDir`, ports, and HTTP/TCP/command health checks. Hook commands are trusted
project code, not model-generated workflows. No agent runtime is installed.

Named, on-demand hooks live in `.biodome/actions/`. `biodome run <target> <action>`
checks compatibility, prepares or reuses the environment, executes the command,
runs optional validation commands, collects declared successful outputs, and
applies the cleanup policy. See [actions](actions.md) for details and limitations.

## Built-in MCP server

External agents may optionally inspect the environment through authenticated MCP:

```json
{
  "project": { "name": "my-app" },
  "mcp": { "enabled": true, "token": { "env": "BIODOME_MCP_TOKEN" } }
}
```

Set a high-entropy token outside version control. Command execution and process
control are disabled by default; enable only the access your agent needs. The
endpoint publishes no agent-specific client configuration. Normal CLI access
through `info`, `exec`, `status`, `logs`, and `shell` requires no MCP server.
