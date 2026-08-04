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

| Plan                                     | Topic               | Priority | Status   | Main Result                                           |
| ---------------------------------------- | ------------------- | -------- | -------- | ----------------------------------------------------- |
| [01](01-package-publishing.md)           | Package publishing  | P0       | complete | Small intentional npm package with valid exports      |
| [02](02-runtime-layout.md)               | Runtime paths       | P0       | complete | One target-aware host/container layout                |
| [03](03-dependency-vulnerabilities.md)   | Dependency security | P0       | complete | No high/critical production audit findings            |
| [04](04-deep-plan-builder.md)            | Plan builder        | P1       | proposed | Deep domain modules behind a narrow context           |
| [05](05-schema-source-of-truth.md)       | Domain schemas      | P1       | proposed | Schema-derived types with invalid states removed      |
| [06](06-shared-artifact-renderer.md)     | Runtime rendering   | P1       | proposed | One common artifact renderer for all drivers          |
| [07](07-testable-mcp-application.md)     | MCP architecture    | P1       | proposed | Side-effect-free, dependency-injected MCP application |
| [08](08-bounded-cloud-volumes.md)        | Cloud volumes       | P1       | proposed | Paginated lists and bounded reads                     |
| [09](09-lazy-runtime-drivers.md)         | Driver loading      | P1       | proposed | Cloud SDKs loaded only when selected                  |
| [10](10-cli-workflows.md)                | CLI architecture    | P1       | proposed | Testable workflows separated from Commander           |
| [11](11-runtime-capability-contracts.md) | Driver capabilities | P2       | proposed | Operation-specific runtime interfaces                 |
| [12](12-event-storage-querying.md)       | Events              | P2       | proposed | O(append-size) writes and bounded queries             |
| [13](13-provider-concurrency-cache.md)   | Providers           | P2       | proposed | Bounded concurrency and atomic catalog cache          |
| [14](14-split-generators.md)             | Generator modules   | P2       | proposed | Cohesive output-oriented generator modules            |
| [15](15-contract-test-suites.md)         | Contract tests      | P2       | proposed | Shared boundary tests across implementations          |
| [16](16-performance-budgets.md)          | Performance         | P3       | proposed | Repeatable benchmarks and regression budgets          |

## Dependency Graph

```text
01 -------------------------------> 15 ----> 16
02 ----> 06 ----> 14 ------------> 15 ----> 16
 |        |
 |        +-----------------------> 15
 +-------> 04

03

05 ----> 04 ----------------------> 15

07 ----> 08 ----------------------> 15 ----> 16
 |
 +------> 13 -----------------------------> 16
 +--------------------------------> 15

09 ----> 10 ----> 11 ------------> 15
 |
 +-------------------------------------> 16

10 ----> 12 ----------------------------> 16
```

## Recommended Execution Waves

### Wave 1: Immediate correctness

These can be implemented in parallel on separate branches:

- Plan 01: package publishing
- Plan 02: runtime layout
- Plan 03: dependency vulnerabilities
- Plan 05: schema source of truth
- Plan 07: testable MCP application
- Plan 09: lazy runtime drivers

### Wave 2: Dependent architecture and performance

Start only after the indicated Wave 1 plans merge:

- Plan 04 after Plans 02 and 05
- Plan 06 after Plan 02
- Plan 08 after Plan 07
- Plan 10 after Plans 02 and 09
- Plan 13 after Plan 07

### Wave 3: Consolidation

- Plan 11 after Plan 10
- Plan 12 after Plan 10 when possible
- Plan 14 after Plan 06

### Wave 4: Cross-cutting proof

- Plan 15 after the relevant contracts have stable implementations
- Plan 16 after Plans 01, 08, 09, 12, and 13

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
