# Public-repository QA with an external controller

This exercises Biodome's command hooks and event log against pinned public
repositories. It does **not** install an agent inside the environment. The Node
controller stands in for the mechanical portion of an external agent: prepare
configuration, launch a declared action, consume live events, poll persisted
cursors, inspect evidence, and verify cleanup.

## Run

Requires Node 22+, Git, Docker Compose, network access, and a built Biodome checkout:

```bash
npm run build
node examples/public-repo-qa/run.mjs /tmp/opencode/biodome-public-qa
# Optional comma-separated subset:
node examples/public-repo-qa/run.mjs /tmp/opencode/biodome-public-qa express,fastapi
```

Repository/dependency code runs inside containers. The controller clones only
into new directories, verifies HEAD, and refuses to replace an existing
`.biodome/` configuration unless its controller marker is present. Inspect all
repository/configuration code before using it with sensitive credentials.

Each repository gets a small environment feature, a Docker Compose target, and
ordinary `qa` / `timeout` action files. The fixture scripts emit `BIODOME_EVENT`
reports and write JSON evidence; TodoMVC also writes desktop/mobile screenshots.
No host ports are published, so these checks do not contend for localhost ports.

## Coverage

| Repository                                                | Pinned revision                            | Behavior checked                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [tastejs/todomvc](https://github.com/tastejs/todomvc)     | `ff43b02e59dfa604386bb382034b2cd07c2bcd8a` | JavaScript ES5 example: create, complete, filter, clear, mobile overflow, browser errors; separate reload-persistence probe |
| [expressjs/express](https://github.com/expressjs/express) | `0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8` | Repository hello-world example: GET, content type, HEAD, 404, conditional ETag                                              |
| [fastapi/fastapi](https://github.com/fastapi/fastapi)     | `03002a00b48335fdd8159edb7920157b508d8c15` | Repository request-body tutorial: OpenAPI, valid requests, missing fields, type rejection/coercion                          |

Every project runs a positive check and an explicit failing assertion after its
real assertions. Express also runs a three-second timeout with evidence saved
before the quiet wait. The controller requires the intended negative-control
check or timeout exit code: an installation failure does not count as a passing
negative control.

TodoMVC additionally runs a **failing persistence probe**. Its ES5 example
explicitly documents in-memory storage in `examples/javascript-es5/README.md`;
requiring todos to survive reload is incompatible with that implementation.
The controller validates that this probe fails with retained evidence. It is not
counted as a successful persistence feature or an established upstream regression.

## Evidence

The chosen root contains `results.json` and
`controller-evidence/<repository>-<case>-<timestamp>/` with:

- `stream.jsonl`: the live persisted event stream, suitable for replay.
- `stderr.log`: ordinary provider diagnostics, separate from JSON stdout.
- `summary.json`: checks, revision, observed live/poll behavior, exit code,
  artifact paths, final outcome, and cleanup verification.

Collected evidence remains in each checkout under
`.biodome-build/targets/local/artifacts/<runId>/`. Failed runs collect available
files before cleanup. Original failed attempts remain in separate run directories.

## Comparison with landed-PR QA

This demonstrates the execution/observation part of that use case, not automatic
interpretation of a PR's acceptance criteria:

1. An external agent resolves the actual landed merge/squash SHA and creates a
   worktree. This fixture controller uses pinned upstream HEADs instead; it does
   not claim those revisions correspond to a selected PR.
2. The project or agent supplies focused acceptance checks. These fixtures use
   repository-owned examples, not full upstream suites or invented deployed apps.
3. Biodome creates the environment and emits live execution/evidence events.
   A quiet heartbeat means alive, not that checks are progressing.
4. The agent reviews JSON, screenshots, logs, source metadata, and the command
   outcome. A child-reported `passed` event is not independent proof.
5. Cleanup is checked separately from the functional result.

Git HEAD plus a dirty flag is provenance, not a source snapshot or attestation.
These trials inject `.biodome/` and generated files; generated ignore files can
make the tracked-worktree flag dirty. Dependencies are not uniformly locked in
the upstream examples, so reruns can resolve different transitive versions.
The trials do not prove production deployment health, migrations, comprehensive
regression coverage, screenshot aesthetics, or autonomous agent judgment.

## Findings

### Verified local trial results

All eight scenarios produced their expected outcomes with live reports observed
before command exit, cursor polling during execution, retained JSON evidence,
and verified container cleanup:

| Project | Scenario                                | Observed result                                                  | End-to-end time |
| ------- | --------------------------------------- | ---------------------------------------------------------------- | --------------- |
| TodoMVC | Functional browser journey (7 checks)   | Passed                                                           | 18.7s           |
| TodoMVC | Stronger reload-persistence requirement | Failed as expected, evidence retained                            | 18.3s           |
| TodoMVC | Deliberate failing assertion            | Exit 7, evidence retained                                        | 19.1s           |
| Express | HTTP behavior (5 checks)                | Passed                                                           | 23.7s           |
| Express | Deliberate failing assertion            | Exit 7, evidence retained                                        | 17.4s           |
| Express | Three-second action timeout             | Exit 124, durable `timed-out` outcome, partial evidence retained | 20.3s           |
| FastAPI | Request validation (5 checks)           | Passed                                                           | 22.5s           |
| FastAPI | Deliberate failing assertion            | Exit 7, evidence retained                                        | 22.7s           |

Times include cached environment preparation and cleanup on this machine, not
isolated application performance. The final trials emitted 194–330 events each,
with no JSON-stream parse errors. TodoMVC retained both desktop/mobile screenshots.
The timeout's incremental evidence correctly remained `status: "running"`; the
authoritative run outcome was `timed-out`, not a fabricated completed report.

These are pinned-revision execution trials with an external scripted controller,
not an autonomous-agent benchmark or verification of a particular landed PR.

### Issues exposed by the trials

The first trial exposed and prompted a fix for invalid generated Dockerfile
`ENV` directives; build-scoped variables now reach dependency installation too.
It also caught an incorrect cache assertion in the trial script: Node's fetch
request was bypassing HTTP freshness. This is why a failing test must be reviewed
rather than automatically attributed to the application under test.

The timeout trial found a second Biodome defect: local drivers enforced the
timeout but failed to pass the configured timeout into result classification,
so exit 124 was recorded as an ordinary failure. Both local drivers now forward
that metadata; the controller requires a durable `timed-out` outcome.

The initial TodoMVC browser test also required reload persistence. Failure logs,
screenshots, and inspection of its documented in-memory store showed the acceptance
criterion was inappropriate for that example. The normal journey now matches its
documented contract; the stronger requirement remains a separate failing probe.

Visual inspection of the retained 390px-wide screenshot also showed the example's
learning sidebar overlapping the todo header/form. The horizontal-overflow
assertion alone does not detect this. Treat the browser journey as functional
coverage, not a mobile-layout approval: an external agent should inspect these
screenshots and decide whether to add a project-specific overlap/visibility check.

See [the action contract](../../docs/actions.md#live-event-log-for-external-agents)
for event schemas, bounds, provider limitations, and cursor semantics.
