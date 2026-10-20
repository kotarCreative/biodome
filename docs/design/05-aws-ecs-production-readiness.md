# Plan 05: Make AWS ECS Production-Ready

Status: partial. Priority: P0. Dependencies: Plans 03 and 04.

> Implemented on branch `feat/ecs-production-readiness`: the implementation and
> local failure-path tests below are in place. The remaining acceptance gate is
> running the opt-in integration workflow against a real AWS account
> (`BIODOME_AWS_INTEGRATION=1 npm run test:integration`), including its
> workspace, secret, job, log, artifact, and zero-leak assertions.
> Local verification was rerun on 2026-09-18: `npm run check` passed with
> 859 unit tests, the build passed, and all 9 local/package integration tests
> passed. This includes building and running the generated ECS image to prove
> its uploaded workspace, target runtime files, secret-file exclusions, AWS
> artifact client, and non-root writable runtime identity. The AWS test remained
> skipped because its required account, network, role, bucket, repository, and
> sentinel-secret environment variables were not configured. ECS therefore
> remains experimental.

## Objective

Turn AWS ECS from an experimental remote driver into a complete, immutable, non-root,
recoverable one-shot task provider with explicit workspace, secret, log, and artifact
contracts.

## Current Baseline

- The driver validates an initial Fargate option schema and can build/push, register,
  start, stop, inspect status, read CloudWatch logs, execute a separate task, and
  collect S3 artifacts.
- Workspace strategy is not materialized for ECS.
- A mutable image tag is returned as if it were a digest.
- Build output is discarded before start and task execution.
- Passthrough credential references are not materialized into ECS tasks.
- Lifecycle start returns after `RunTask`, before the task is usable or terminal.
- Some AWS errors are converted into missing/stopped states.
- The generated container runs as root.
- No opt-in AWS integration test proves the complete workflow.

## Locked Decisions

- ECS named tasks use the one-shot job operation from Plan 03, not in-place exec.
- An ECS named task's workload, validation commands, and artifact publication run
  inside one Fargate task so they share the same mutated workspace.
- `biodome exec` fails for ECS unless true ECS ExecuteCommand is designed and enabled
  separately.
- ECS supports only explicit remote workspace strategies such as clone, upload, or
  snapshot. It never accepts a host bind strategy.
- Images are registered and run by immutable `repository@sha256:...` reference.
- Secret references are resolved immediately before the AWS call that needs them and
  are never written to manifests, state, events, or default errors.
- Prefer ECS `secrets` backed by an explicit AWS secret reference. Host-resolved values
  require an explicit exposure policy and redaction tests.
- Task startup waits with a bounded, injectable polling policy until `RUNNING` or a
  terminal failure.
- Every created resource is either recorded in recoverable state or rolled back.
- ECS workloads use the non-root identity established by Plan 04.
- Remove or reject `ttl` until a durable cloud-side expiry mechanism is implemented.
  A local timer is not a lifecycle guarantee.
- CloudWatch log access covers aggregate container stdout/stderr and named job
  streams. Process-scoped daemon logs remain unsupported until supervisor files
  are explicitly forwarded; requesting one fails rather than returning unrelated
  container output.

## Files

- `src/runtime/aws-ecs-schema.ts`
- `src/runtime/aws-ecs.ts`
- `src/runtime/state.ts`
- `src/orchestration/`
- `src/core/task-runner.ts`
- AWS runtime and orchestration tests
- Opt-in tests under `src/tests/integration/`

## Implementation Steps

1. Update ECS options to declare one supported workspace source and validate all
   strategy-specific fields.
   Provider-specific validation must run during `target validate`, `plan`, `build`,
   `up`, and `run` before availability checks or AWS calls.
2. Reject bind workspaces, unsupported backing services, unsupported secret exposure,
   and incompatible network requirements during compatibility preflight.
3. Implement deterministic workspace materialization before agent execution.
4. Produce the real pushed image digest through Buildx metadata or ECR inspection and
   persist the Plan 03 build manifest.
5. Register task definitions with the immutable digest reference from that manifest.
6. Materialize declared secret/environment requirements through one typed mapper and
   fail clearly when required references are unavailable.
7. Apply the non-root user, writable path, read-only filesystem decision, dropped
   privilege, and Fargate network restrictions to task definitions.
8. Inspect `RunTask.failures` and poll `DescribeTasks` until running or terminal with a
   bounded timeout and injectable clock/sleep.
9. Map AWS authorization, throttling, transport, missing-resource, and terminal-task
   failures distinctly. Do not report provider errors as “not found.”
10. Persist provisional resource identity before waiting, then update state atomically
    when running or failed.
11. Make stop idempotent and clean up task definitions only when no active task uses
    them.
12. Keep CloudWatch log-group and stream identity explicit in state; do not enumerate
    account-wide streams.
13. Upload declared job artifacts to S3 automatically, then validate collected
    keys, sizes, required/optional semantics, and IAM failures.
14. Remove the misleading in-place `exec.command` capability and advertise the job
    operation instead.
15. Add a manually enabled integration test that builds, starts, observes, collects,
    stops, and cleans every created resource in a `finally` path.

## Required Tests

- Workspace strategies are accepted or rejected before AWS calls.
- Malformed ECS options and unsupported host-secret materialization fail in every
  CLI preflight path without rendering files or contacting AWS.
- Build returns and persists a real `sha256` digest; registration uses that digest.
- Secret mapping includes required references and no resolved value reaches artifacts,
  state, events, snapshots, or errors.
- Task definitions assert non-root identity, Fargate networking, no host mount, no
  privileged mode, and intended filesystem settings.
- Startup polling covers pending, running, stopped, timeout, `RunTask.failures`, and
  cleanup after partial creation.
- Lost registration and `RunTask` responses reconcile paginated family resources,
  retain discovered task/task-definition ARNs when cleanup fails, and never run
  reconciliation after a definitive authorization rejection.
- Status distinguishes missing tasks from AWS errors.
- Stop is idempotent for stopped and missing tasks.
- Rollback, stop, and job cleanup deregister task definitions before requesting
  deletion and accept the provider's `DELETE_IN_PROGRESS` lifecycle state.
- Successful jobs automatically upload declared artifacts; collection enforces
  declared keys and byte limits.
- One-shot validation runs after the workload and before artifact publication in
  the same ECS task.
- Driver contracts advertise job execution and reject in-place exec.

## Acceptance Criteria

- An ECS task receives the declared repository workspace and required credentials.
- The exact immutable image built for a run is the image registered and executed.
- `up` and named task execution cannot report success before ECS is usable or terminal.
- Failed starts retain enough validated state for cleanup or roll back all resources.
- ECS task definitions and persisted files contain no resolved secrets.
- The opt-in AWS integration workflow passes and leaves no running task or generated
  task definition behind.

## Verification

```bash
npm run test:run -- src/tests/runtime/aws-ecs.test.ts src/tests/orchestration
npm run check
npm run build
npm audit --omit=dev --audit-level=high
BIODOME_AWS_INTEGRATION=1 npm run test:integration
```

The AWS integration variables may be exported by the shell or stored in
`.biodome/.env`, which the integration test loads before checking its opt-in flag.

Results from 2026-09-18:

- Focused ECS readiness suite: 157 tests passed, including runtime,
  orchestration, task-runner, artifact-path, and CLI preflight coverage.
- `npm run check`: formatting, lint, typecheck, and 859 tests passed.
- `npm run build`: passed.
- `npm run test:integration`: 9 tests passed, including the generated ECS image
  build/run proof; the opt-in AWS test was skipped.
- `npm audit --omit=dev --audit-level=high`: passed the high/critical gate; 8
  moderate transitive advisories remain visible.
- The credentialed AWS command was not run because `AWS_REGION`, ECS cluster,
  ECR repository, subnets, security groups, execution/task roles, S3 bucket, and
  `BIODOME_ECS_SENTINEL_SECRET_ARN` were absent from the environment.
