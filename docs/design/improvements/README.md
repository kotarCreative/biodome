# Biodome Improvement Plans

Status: active. This directory turns the project review into independently executable implementation plans.

## How to Use These Plans

Give one plan to one implementation session. Do not ask a small model to execute multiple plans at once.

Before implementing a plan, the executor must:

1. Read the complete plan.
2. Read every production file listed in its `Files` section.
3. Read the closest existing tests before editing production code.
4. Confirm every dependency plan is complete in the current branch.
5. Run the plan's focused baseline tests.
6. Make only changes required by the plan.
7. Run required tests and final verification before reporting completion.

The executor must not:

- Invent backward-compatibility behavior; this project is greenfield.
- Combine adjacent plans because files overlap.
- Replace named design decisions with a different architecture without updating the plan first.
- Defer tests to another plan or pull request.
- Mark acceptance criteria complete without command output proving verification.

## Plans

| Plan                          | Topic             | Priority | Status   | Main Result                                 |
| ----------------------------- | ----------------- | -------- | -------- | ------------------------------------------- |
| [04](04-deep-plan-builder.md) | Plan builder      | P1       | proposed | Deep domain modules behind a narrow context |
| [14](14-split-generators.md)  | Generator modules | P2       | proposed | Cohesive output-oriented generator modules  |
| [16](16-performance-budgets.md) | Performance     | P3       | proposed | Repeatable benchmarks and regression budgets |

## Dependency Graph

```text
04 ----> 14 ----> 16
```

## Recommended Execution Waves

### Wave 1: Plan builder

- Plan 04: complete the remaining domain extractions.

### Wave 2: Generator modules

- Plan 14 after Plan 04.

### Wave 3: Performance proof

- Plan 16 after Plan 14 and the existing runtime and MCP improvements.

## Pull Request Boundaries

Use one pull request per numbered plan except Plan 04. Plan 04 should use one pull request per migrated domain after its facade and `ProjectIO` foundation land.

For Plan 04, use this order:

1. Foundation and `ProjectIO`.
2. Environment.
3. Processes.
4. Services.
5. Repositories.
6. Volumes.
7. Providers.
8. Harnesses.
9. Build and final facade cleanup.

Do not merge a migration pull request while old and new modules both mutate the same domain state.

## Completion Report Template

Each implementation session should finish with this report:

```text
Plan: <number and title>
Status: complete | partial | blocked
Files changed: <paths>
Behavior changed: <short factual list>
Tests added: <paths and cases>
Verification run: <commands and results>
Acceptance criteria not met: <none or exact items>
Follow-up discovered: <none or separate issue; do not expand current scope>
```

## Global Quality Gate

Every completed plan must pass:

```bash
npm run check
npm run build
```

Run `npm run test:integration` whenever a plan changes generated files, runtime paths, drivers, task execution, package installation, or container behavior.
