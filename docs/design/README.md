# Biodome Design Plans

Status: active. These plans replace the historical named-target and
security/performance plans, whose implementation status and architecture no longer
matched the repository.

## Current Architecture

New work must preserve these boundaries:

- `Plan` is the project configuration and build intermediate representation.
- `ExecutionPlan` is the provider-neutral contract for one named task execution.
- Runtime drivers expose capability-segmented operation interfaces.
- Compatibility checks reject unsupported requirements before resources are created.
- Run records and target-scoped event logs provide durable operational history.
- Docker Compose, Docker Sandboxes, and AWS ECS are built-in runtime providers.

Do not restore the old monolithic driver interface or add provider-specific CLI
commands.

## Plans

| Plan                                     | Topic               | Priority | Depends on | Status   | Result                                                             |
| ---------------------------------------- | ------------------- | -------- | ---------- | -------- | ------------------------------------------------------------------ |
| [01](01-mcp-authentication.md)           | MCP authentication  | P0       | None       | Complete | Mandatory auth with supported generated clients                    |
| [02](02-secrets-and-repositories.md)     | Secret handling     | P0       | 01         | Complete | Typed secret references and credential-safe repository sync        |
| [03](03-runtime-execution-contracts.md)  | Runtime contracts   | P0       | 02         | Partial  | Portable workspace, secret, job, build, state, and event contracts |
| [04](04-container-process-isolation.md)  | Local containment   | P1       | 01, 02     | Proposed | Non-root processes and explicit direct-mount risk boundaries       |
| [05](05-aws-ecs-production-readiness.md) | AWS ECS             | P0       | 03, 04     | Proposed | A tested, immutable, recoverable remote task provider              |
| [06](06-bounded-mcp-io.md)               | MCP resource bounds | P1       | 01, 02     | Partial  | Bounded commands, telemetry, uploads, and adapters                 |
| [07](07-event-observability.md)          | Events              | P1       | 03, 06     | Partial  | Scoped, bounded, correctly ordered operational events              |
| [08](08-security-release.md)             | Release hardening   | P1       | 01-07      | Proposed | Accurate security documentation and release automation             |
| [09](09-performance-budgets.md)          | Performance proof   | P2       | 03, 06, 07 | Proposed | Stable package budgets and non-blocking startup trends             |

## Execution Order

1. Complete Plans 01 and 02 before expanding remote execution.
2. Complete Plan 03 before changing ECS behavior or adding another remote provider.
3. Plans 04 and 06 may proceed in parallel after their dependencies are complete.
4. Complete Plan 05 only after the provider-neutral contracts and container identity
   model are settled.
5. Complete Plan 07 after event scope is added by Plan 03 and bounded queues exist
   from Plan 06.
6. Publish the security release documentation in Plan 08 only after behavior is
   final.
7. Establish performance baselines last so architecture changes do not invalidate
   them immediately.

## Plan Rules

Before implementing a plan:

1. Read the complete plan and every production file in its `Files` section.
2. Read the closest unit, contract, and integration tests.
3. Confirm every dependency acceptance criterion in the current branch.
4. Record focused baseline command results.

While implementing:

- Keep the change within one plan's stated boundary.
- Update the plan first if a locked decision must change.
- Do not add compatibility behavior unless persisted data or an external consumer
  requires it.
- Do not claim a security boundary that same-identity container processes can bypass.
- Reject unsupported requirements before provider API calls or resource creation.
- Add tests in the same change as behavior.

Every completed plan must pass:

```bash
npm run check
npm run build
```

Run `npm run test:integration` when generated files, runtime paths, drivers, task
execution, package installation, or container behavior changes.

## Completion Report

```text
Plan: <number and title>
Status: complete | partial | blocked
Files changed: <paths>
Behavior changed: <short factual list>
Tests added: <paths and cases>
Verification run: <commands and results>
Acceptance criteria not met: <none or exact items>
Follow-up discovered: <none or separate issue>
```
