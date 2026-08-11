# Plan 09: Add Stable Performance Budgets

Status: proposed. Priority: P2. Dependencies: Plans 03, 06, and 07.

## Objective

Protect package footprint and detect major startup regressions without making pull
requests depend on noisy hosted-runner microbenchmarks.

## Current Baseline

- The package publish allowlist contains `dist`, README, and LICENSE.
- The package contract test packs, installs, imports, checks exports, and runs the
  installed CLI.
- Runtime drivers are lazy-loaded, making package-root import and CLI startup useful
  architecture signals.
- No benchmark command, result schema, baseline file, or CI artifact exists.
- Provider concurrency, volume pagination, and event retention already have stronger
  deterministic correctness tests than elapsed-time benchmarks would provide.

## Locked Decisions

- Package file count, compressed bytes, and unpacked bytes are deterministic blocking
  budgets.
- CLI cold startup and public-root import are non-blocking trends until CI variance is
  measured over multiple main-branch runs.
- Measure cold operations in fresh Node processes against a production build.
- Store raw samples, median, and a high percentile in schema-validated JSON.
- Do not gate pull requests on noisy sub-100ms differences or one relative comparison.
- Prefer deterministic operation/count invariants over filesystem, fake-network, or
  timer microbenchmarks.
- Benchmarks run without Docker, cloud credentials, or network access.

## Files

- Add `benchmarks/runner.mjs`
- Add `benchmarks/schema.json` or an equivalent checked schema
- Add deterministic fixtures only when required
- `package.json`
- `src/tests/package/package.test.ts`
- Add focused benchmark-runner tests under `src/tests/`
- `.github/workflows/ci.yml`
- `docs/testing.md`

## Initial Metrics

Blocking:

- Packed file count.
- Packed compressed byte size.
- Packed unpacked byte size.
- Forbidden publish paths.
- Benchmark result schema and budget comparison behavior.

Non-blocking:

- `node dist/cli/index.js --help` cold process duration.
- Cold import duration for `dist/index.js` in a fresh process.

Explicitly excluded from timing gates:

- Near-rotation event append.
- Fake provider catalog refresh.
- Cloud-volume page transformation.
- Individual pure generator functions.

## Implementation Steps

1. Add a small Node benchmark runner without a framework dependency.
2. Build once, then execute each cold timing sample in a fresh child process.
3. Record environment metadata: commit, Node/npm versions, OS, architecture, CPU,
   sample count, and every raw sample.
4. Report median and p90 or p95 without discarding outliers silently.
5. Reuse `npm pack --json` and the package contract allowlist to collect deterministic
   package metrics.
6. Establish generous absolute package budgets from a clean production build.
7. Add pass, fail, missing-budget, malformed-result, and synthetic-regression tests.
8. Add `npm run benchmark` and a concise human-readable table.
9. Upload benchmark JSON from CI even when a deterministic budget fails.
10. Keep timing results non-blocking while collecting enough main-branch samples to
    characterize variance.
11. Add a documented, review-required process for changing absolute budgets.
12. Consider future plan-build, full-render, and event-query trends only after defining
    stable fixture size and operation contracts.

## Required Tests

- Identical fixture input produces schema-equivalent deterministic package results.
- Budget comparison handles pass, fail, missing budget, and invalid metric types.
- A synthetic package regression exits nonzero and names the metric, observed value,
  budget, and reproduction command.
- JSON output validates against the result schema.
- Timing failures do not fail CI while metrics are configured as trend-only.

## Acceptance Criteria

- `npm run benchmark` works after `npm run build` without Docker or network access.
- Package size and file-count regressions fail with actionable output.
- CLI and package-import samples are retained as CI artifacts but do not create flaky
  pull-request failures.
- The package contract test and benchmark use one publish allowlist and cannot drift.
- No benchmark gates on provider timers, cloud latency, or sub-100ms relative changes.

## Verification

```bash
npm run build
npm run benchmark
npm run test:run
npm run check
```
