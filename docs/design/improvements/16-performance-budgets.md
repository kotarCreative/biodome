# Plan 16: Add Performance Budgets

Status: proposed. Execute after the main architecture and bounded-I/O plans.

## Objective

Measure high-value workflows consistently and fail CI only on large, repeatable regressions.

## Dependencies

- Complete Plans 01, 08, 09, 12, and 13 first.

## Files

- Add benchmark scripts below `benchmarks/`.
- Add small deterministic fixtures below `benchmarks/fixtures/`.
- Add package scripts.
- Add a non-blocking or blocking CI benchmark job according to stability results.
- Document baseline hardware/environment assumptions.

## Locked Decisions

- Benchmark user-visible operations, not isolated array methods.
- Use production builds for startup and package measurements.
- Use deterministic fake providers for provider and volume benchmarks.
- Keep network access out of default benchmarks.
- Start with generous budgets and tighten only after collecting CI variance.
- Record raw results as CI artifacts.

## Benchmark Cases

- Built CLI `--help` cold startup.
- Importing the public package root.
- Building a plan with 100 representative feature contributions.
- Rendering common artifacts for a complete plan.
- Appending events to a near-rotation log.
- Querying recent events across many run files.
- Refreshing 20 fake provider catalogs with configured concurrency.
- Listing one cloud-volume page at maximum allowed size.
- Packed file count, compressed size, and unpacked size.

## Implementation Steps

1. Choose one benchmark runner: a small Node script is sufficient; do not add a framework unless it materially improves repeatability.
2. Add fixture builders that do not depend on the developer's workspace state.
3. Run warm-up iterations and multiple measured iterations.
4. Report median and a high percentile; do not gate on a single run.
5. Add JSON output for CI artifact upload and a concise human table.
6. Establish local and CI baselines after architecture plans land.
7. Add generous absolute budgets for package size and bounded operation counts.
8. Use relative timing budgets only where CI variance is demonstrated to be low.
9. Add a documented command for updating baselines with review.
10. Fail with the benchmark name, observed value, budget, and reproduction command.

## Required Tests

- Benchmark fixture generation is deterministic.
- Budget comparison handles pass, fail, and missing baseline cases.
- Benchmarks exit nonzero when a synthetic value exceeds its budget.
- Output JSON validates against a small schema.

## Acceptance Criteria

- `npm run benchmark` runs without Docker or network access.
- Package size, CLI startup, event querying, provider refresh, and volume listing have recorded budgets.
- CI stores benchmark results for trend inspection.
- A deliberate synthetic regression proves budget failure works.

## Non-Goals

- Microbenchmarking JavaScript syntax choices.
- Comparing cloud provider network latency.
- Blocking pull requests on noisy sub-100ms timing differences.

## Verification

```bash
npm run build
npm run benchmark
npm run check
```
