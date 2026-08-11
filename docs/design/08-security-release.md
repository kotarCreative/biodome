# Plan 08: Prepare the Security Release

Status: proposed. Priority: P1. Dependencies: Plans 01 through 07.

## Objective

Publish accurate security guidance, migration instructions, dependency automation,
and verification evidence for the completed authentication, secret, containment,
runtime, and resource-bound changes.

## Locked Decisions

- Documentation describes implemented behavior only; it must not preannounce an
  incomplete security boundary.
- Breaking security defaults receive explicit migration steps rather than hidden
  compatibility paths.
- High and critical production dependency advisories block CI.
- Moderate advisories remain visible with their dependency owner and remediation
  status.
- Security reports use a private contact or advisory channel, never a public issue
  requirement.
- ECS remains documented as experimental until Plan 05 acceptance criteria and its
  opt-in integration test pass.

## Files

- `SECURITY.md`
- `README.md`
- `docs/index.md`
- `docs/api.md`
- `docs/processes.md`
- `docs/primitives.md`
- `docs/file-layout.md`
- `docs/orchestration.md`
- `docs/ROADMAP.md`
- `.github/dependabot.yml`
- `.github/workflows/ci.yml`
- Release notes or changelog

## Implementation Steps

1. Add `SECURITY.md` with supported versions, private reporting instructions,
   expected response handling, and immediate token/credential revocation guidance.
2. Add Dependabot groups for npm production dependencies, npm development tooling,
   and GitHub Actions with a reasonable schedule and update limit.
3. Document mandatory MCP token configuration, authenticated client behavior,
   capability authorization, rotation, and the same-container threat model.
4. Document environment-reference-only secret fields and the redacted information API
   behavior.
5. Document HTTPS askpass behavior, pinned SSH known hosts, and repository migration.
6. Document non-root runtime identities, proxy-volume recommendation, direct FUSE
   opt-in risk, and UID/GID configuration.
7. Document command, request, volume, queue, event-size, retention, and query limits.
8. Document provider-neutral workspace/job semantics and accurate capability errors.
9. Document ECS prerequisites, workspace transfer, IAM, logs, artifacts, immutable
   images, cleanup, and any remaining unsupported operations.
10. Add a concise migration guide covering every breaking field and default.
11. Correct the roadmap so completion claims match verified tests, especially ECS.
12. Confirm CI runs format, lint, typecheck, unit tests, high-severity audit, build, and
    integration jobs in their intended environments.
13. Inspect generated representative artifacts for secret values, root workloads,
    unsafe SSH options, excessive capabilities, and unauthenticated MCP endpoints.

## Required Checks

- Documentation search finds no token-optional MCP examples.
- Documentation search finds no literal credential examples on secret fields.
- Documentation search finds no `StrictHostKeyChecking=no` or `accept-new` guidance.
- Every CLI example uses current named-target syntax.
- Public capability and provider limitations match runtime contract tests.
- Dependabot configuration parses and targets the correct package ecosystem.

## Acceptance Criteria

- Users can migrate every changed security default using documented steps.
- `SECURITY.md` provides a private, actionable reporting path.
- Public docs match schemas, generated behavior, and runtime capabilities.
- Roadmap completion claims are backed by unit/contract/integration tests.
- CI blocks high/critical production advisories and all standard quality failures.

## Verification

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run test:integration
npm audit --omit=dev --audit-level=high
```
