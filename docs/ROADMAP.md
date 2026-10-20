# Roadmap

## Current direction

Simple file-based environment creation is the product. Embedded agents, generated
agent configuration, and harness-based tasks have been removed. On-demand actions
and lifecycle hooks expose command intent, JSON input, and expected output files
to external agents. See [actions](actions.md) for migration and branch workflows.

Next priorities: prove simpler configuration and fast application readiness on
real QA/performance workloads; improve failure evidence and concurrent-run
isolation before expanding providers or orchestration. The milestones below are
historical implementation status, not a commitment to restore removed features.

## Completed

- [x] Target loading and Docker rendering
- [x] Named task plans and harness wrappers
- [x] Artifact collection and `run` command
- [x] End-to-end local task execution workflow
- [x] Docker timeout enforcement and bounded output
- [x] Task preflight capability checks
- [x] Provider-neutral execution plans and durable run records
- [x] Initial ECS task execution and S3 artifact collection
- [x] Mandatory MCP authentication (Plan 01)
- [x] Typed secret handling and repository sync (Plan 02)
- [x] Non-root local container and process isolation (Plan 04)

## Partially complete

- [~] Provider-neutral runtime execution contracts (Plan 03) — durable `BuildManifest`, state validation, and scoped events are implemented; provider-profile support and the in-place exec / one-shot job split need finalization.
- [~] Bounded MCP I/O (Plan 06) — configurable command limits and a spawn-based runner are implemented; telemetry queue hardening and upstream abort propagation remain.
- [~] Event observability (Plan 07) — bounded, target-scoped event logs and CLI queries are implemented; lifecycle-event equivalence across all drivers and redaction defaults need finalization.
- [~] AWS ECS production hardening (Plan 05) — immutable images, readiness health, lost-response reconciliation, durable cleanup state, task-definition deletion, workspace/secrets/jobs/logs/artifacts, non-root identity, and Fargate validation are implemented. On 2026-09-18, 859 unit tests, the build, and 9 local/package integration tests passed, including a real build-and-run proof of the generated ECS image; the AWS proof was skipped because its required account configuration was absent. ECS remains experimental until `BIODOME_AWS_INTEGRATION=1 npm run test:integration -- src/tests/integration/aws-ecs.test.ts` passes without leaked resources.

## Upcoming

- [ ] Security release documentation and automation (Plan 08)
- [ ] Stable package and startup performance budgets (Plan 09)

See [the active design plans](design/README.md) for dependencies, acceptance criteria,
and verification commands.
