# API reference

## Plan building

```typescript
import {
  buildPlan,
  buildTargetPlan,
  buildActionPlan,
  validateConfig,
  validateFeatures,
  validatePlan,
} from "@kotarcreative/biodome";
import type { FeatureContext, ActionContext, ActionSpec } from "@kotarcreative/biodome";
```

`buildPlan(rootDir)` reads the file-based environment. `buildTargetPlan(rootDir,
target)` selects a provider. `buildActionPlan(rootDir, target, action)` adds a
command from `.biodome/actions/`. Effect variants have the `Effect` suffix.
`buildTaskPlan` and `TaskSpec` remain aliases/internal terminology for existing
programmatic consumers; their shape is now command-based, not harness-based.

## Environment context

Feature and service files export a default function receiving `FeatureContext`.
See [Primitives](primitives.md) for examples.

| Method                                       | Purpose                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `addLanguage(name, options?)`                | Language/version and package manager                    |
| `addPackage(manager, name, options?)`        | Project tooling dependency                              |
| `addTool(name, options?)`                    | System or built-in tool                                 |
| `addService(name, options?)`                 | Postgres/Redis backing service                          |
| `addProcess(spec)`                           | Managed application process                             |
| `addHook(spec)`                              | Lifecycle command, optionally with input/output/intent  |
| `addRepo(spec)`                              | Repository URL, branch, path, and credential references |
| `addEnv(key, spec)`                          | Literal configuration or runtime credential reference   |
| `addEndpoint(spec)`                          | Discoverable URL/port and metadata                      |
| `addVolume(spec)`                            | Local/cloud storage, subject to target capabilities     |
| `addProvider(spec)`                          | Optional external service metadata/MCP connection       |
| `fileExists`, `readFile`, `readJSON`, `exec` | Trusted host-side authoring helpers                     |

Provider and volume convenience methods remain available through the typed
`FeatureContext`. Agent installation, generated agent homes, LLM-provider
configuration, and the `add*Harness` APIs have been removed.

## Action context

An action file exports a function that calls `ctx.addAction(spec)` once:

```typescript
interface ActionSpec {
  command: string[];
  intent: string;
  input?: Record<string, unknown>; // JSON values, at most 64 KiB
  outputs?: string[]; // explicit workspace-relative paths
  timeout?: string; // positive integer + s/m/h; default 20m
  cleanup?: "always" | "on-success" | "never"; // default never
  requiredServices?: string[];
  requiredProcesses?: string[];
  validationCommands?: string[][];
}
```

The full type additionally supports capability, network, workspace, and resource
requirements. Unsupported requirements fail preflight rather than imply security
enforcement. See [actions](actions.md) for invocation input, output collection,
branch workflows, and current provider limitations.

## Hooks and processes

Both use `name`, argv `command`, optional `workingDir`, `environment`, and
`identity`. Processes can declare `port`/`ports`, a health check, and `bootstrap`.
Hooks require `startOn` and may declare `intent`, JSON `input`, and `outputs`.
Metadata-bearing hooks receive the same `BIODOME_ACTION_*` variables as actions.

Lifecycle points are `build.pre`, `build.post`, `start.pre`, `start.post`,
`stop.pre`, `stop.post`, `exec.pre`, and `exec.post`. A declared lifecycle point
does not make a hook a separate durable workflow.

## Credentials

```javascript
ctx.addEnv("API_TOKEN", { from: { env: "API_TOKEN" }, required: true });
ctx.addEnv("AWS_SECRET", {
  from: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:example" },
  required: true,
});
```

Host references resolve at runtime. AWS secret ARN references use native ECS
injection; local Compose resolves the variable by its declared name instead.
Repository tokens, SSH keys, endpoint/provider credentials, and volume credentials
use `{ env: "VAR" }` references rather than literal secrets. SSH keys additionally
require pinned `knownHosts`. Do not put credentials in action input or intent.
See [AWS ECS](aws-ecs.md) for account/IAM requirements and experimental status.

## Application recipes

```typescript
import { app, service, defineAppRecipe } from "@kotarcreative/biodome/app";
import { computerUse } from "@kotarcreative/biodome/recipes/computer-use";
```

App recipes expand to environment primitives; they do not run agent workflows.
See [apps](apps.md) and [browser tooling](recipes/computer-use.md).
