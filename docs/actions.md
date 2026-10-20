# Environment actions

Biodome creates environments from small files. An action is an on-demand command
hook in that environment, not an agent workflow. Your agent stays outside and
chooses what to invoke; Biodome does not install agents, select models, or manage
prompts and conversations.

Use [profiles](profiles.md) to run the same action against different named setups
without editing its checks or target infrastructure.

## Declare an action

One file in `.biodome/actions/` declares one action. The filename is its name.

```javascript
// .biodome/actions/e2e.mjs
export default function e2e(ctx) {
  ctx.addAction({
    command: ["node", "scripts/e2e.mjs"],
    intent: "Check the branch's checkout journey against the running application",
    input: { journey: "checkout", viewport: "desktop" },
    outputs: ["results/e2e.json", "results/checkout.png"],
    timeout: "10m",
    cleanup: "always",
  });
}
```

The command receives these environment variables:

| Variable                 | Value                                                  |
| ------------------------ | ------------------------------------------------------ |
| `BIODOME_ACTION_NAME`    | The action filename without its extension              |
| `BIODOME_ACTION_INTENT`  | Why the action is running                              |
| `BIODOME_ACTION_INPUT`   | JSON object with invocation input                      |
| `BIODOME_ACTION_OUTPUTS` | JSON array of expected workspace-relative output paths |

For example, `scripts/e2e.mjs` can read
`JSON.parse(process.env.BIODOME_ACTION_INPUT)`. The script owns input semantics
and writes the declared files. Biodome passes metadata as argv/environment data;
it never substitutes input into shell source. Scripts must preserve that boundary
and must not `eval` untrusted input.

`command` and a nonblank `intent` are required. Input defaults to `{}`, outputs to
`[]`, timeout to `20m`, and cleanup to `never`. JSON input is limited to 64 KiB;
intent is limited to 16 KiB. Outputs are explicit relative paths, not globs.

```bash
biodome plan local e2e --json
biodome run local e2e --input '{"journey":"guest-checkout"}' \
  --intent "Verify the regression fix" --json
```

`--input` shallow-merges into defaults. `--intent` replaces the declared intent.
`--output results/e2e.json results/checkout.png` replaces the output list; the
command must honor the new paths. Planning validates the action and target without
starting resources. Running builds and starts the environment if necessary, or
reuses a running target. Required services/processes and provider compatibility
are checked before execution.

Declared files are collected under
`.biodome-build/targets/<target>/artifacts/<runId>/`. Successful runs require all
declared files. Failed and timed-out commands attempt every file independently,
before cleanup, preserving available evidence and the original command failure.
Write evidence incrementally: a terminated script cannot run its finalizer. Clear
or replace old workspace outputs at the start of each invocation to avoid stale
evidence. Per-run destination directories prevent later collections overwriting
earlier evidence; they do not prove when a source file was created.

`--json` returns bounded stdout/stderr, artifact paths, timing, and the run record
on success. On failure it returns a JSON error with run ID, log path, command exit
code (when available), and collected artifacts, alongside a nonzero CLI exit.
`cleanupFailed` is separate from the QA outcome: callers must inspect it even when
the checks pass. `never` preserves the environment; `always` cleans up on success
and failure; `on-success` preserves failed environments.

Input, intent, command arguments, and output contents are not secrets. They may
appear in explicit plan output or generated configuration; `--json` command output
can contain sensitive application data. Use `addEnv()` references for credentials,
test accounts, and appropriate retention controls for results.

## Live event log for external agents

```bash
biodome run local e2e --stream > run.jsonl
# The first run.started record contains the run ID, before environment setup.
biodome events --run <runId> --after 0 --limit 1000 --json
```

`--stream` writes persisted events as JSON Lines to stdout, routing ordinary
provider progress to stderr. It requires event capture and cannot be combined
with `--json`. An external controller can consume it while the command runs;
Biodome does not start an agent or manage its reasoning.

Events have `runId`, monotonic per-run `sequence`, `timestamp`, `type`, `scope`, and
`data`. The log covers plan loading, Git HEAD and dirty-worktree metadata,
environment build/start, local provider output, action phases, stdout/stderr,
reported checks, artifacts, diagnostic log snapshots, cleanup, and final results.
`environment.ready` includes the selected image reference/digest when available.
`runtime.heartbeat` every five seconds indicates a live operation, **not progress**.
`action.result` records the QA exit and evidence; `run.completed` / `run.failed`
close the CLI operation. A failed assertion is never a completed runtime command.

Cursor pages return `events`, `nextSequence`, `hasMore`, `complete`, `outcome`,
`firstAvailableSequence`, `gap`, and parse diagnostics. Persist `nextSequence` and
poll again; keep draining while `hasMore` is true even if `complete` is true.
An empty page without a terminal record is not proof of completion. A retention
`gap` means the history is incomplete. Abrupt process termination can leave no
terminal event; there is no background daemon or automatic recovery.

### Optional script reports

Scripts can emit a single bounded JSON object after the literal prefix
`BIODOME_EVENT ` on a stdout or stderr line:

```javascript
console.log(
  "BIODOME_EVENT " +
    JSON.stringify({
      type: "check",
      name: "guest checkout",
      status: "passed",
      message: "Order confirmation displayed",
    }),
);
```

Allowed types are `progress`, `check`, and `artifact`. `message` is required
(maximum 4096 characters); optional `name` is limited to 256 characters, `status`
is `passed`, `failed`, `blocked`, or `skipped`, and `path` must be a safe relative
artifact path (maximum 1024 characters). Invalid reports remain ordinary logs and
produce `action.report.invalid`. Reports are untrusted child claims, marked
`reported: true`: they cannot forge lifecycle events, collect undeclared files,
or override the process exit code. Agents should inspect actual evidence too.

### Bounds and provider differences

- Output is UTF-8 framed, with 8192-character text frames and a 1 MiB retained limit per
  stream per instrumented operation; `runtime.output.truncated` makes drops explicit.
  Lines without a newline can be delayed until a frame fills or the process ends.
- Existing event-log retention is bounded: 10 MiB segments, five rotated segments,
  and a directory retention cap of 100 event files. Archive evidence externally
  if durable audit retention is required. Artifact files have no automatic expiry.
- Docker Compose captures startup container output and finite supervised-process
  log snapshots before cleanup. Managed application logs are not a continuous
  timeline; `biodome logs` remains the interactive follower.
- Docker Sandbox captures CLI/action output and finite process-log snapshots.
  ECS jobs currently return CloudWatch output after completion, not live output;
  remote failure evidence depends on the provider successfully uploading it.
- Known host credential values and common credential patterns are redacted from
  output events on a best-effort basis. This is not a DLP boundary: arbitrary guest
  secrets, raw terminal output, returned stdout/stderr, and artifacts can still be
  sensitive. Do not print credentials or use production accounts for QA.

See [public-repository QA trials](../examples/public-repo-qa/README.md) for a
controller that consumes live events, polls cursors, and verifies negative controls.

## Lifecycle hooks use the same contract

Existing hooks remain ordinary commands. They may optionally declare the same
input, output, and intent metadata:

```javascript
// .biodome/features/seed.mjs
export default function seed(ctx) {
  ctx.addHook({
    name: "seed-test-data",
    startOn: "start.pre",
    command: ["node", "scripts/seed.mjs"],
    intent: "Prepare throwaway accounts for QA",
    input: { fixture: "checkout" },
    outputs: ["results/seed.json"],
  });
}
```

The hook gets its own `BIODOME_ACTION_*` values, scoped to that command. Lifecycle
hook outputs describe expected files; they are not independently collected.
Include those paths in a named action's outputs if they should be returned.

## Performance testing

```javascript
// .biodome/actions/performance.mjs
export default function performance(ctx) {
  ctx.addAction({
    command: ["node", "scripts/performance.mjs"],
    intent: "Measure latency and throughput for the candidate branch",
    input: { durationSeconds: 30, concurrency: 5 },
    outputs: ["results/performance.json"],
    timeout: "5m",
    cleanup: "always",
  });
}
```

The project owns the performance tool and pass/fail thresholds. Compare branches
with the same target sizing, fixtures, and load; Biodome does not make a noisy
shared machine a controlled benchmark environment.

## Work on a branch without changing your checkout

Use Git worktrees rather than letting Biodome switch branches underneath you:

```bash
git worktree add --detach ../app-qa feature/checkout
cd ../app-qa
npx @kotarcreative/biodome run local e2e --json
```

Commit `.biodome/` to the branch before creating the worktree. Uncommitted files,
ignored `.biodome/.env`, and installed recipe dependencies are not copied; prepare
those in the new checkout as needed. Targets are scoped to the checkout path, so
two worktrees do not share container identities or cleanup ownership. Fixed host
ports can still conflict: stop the other environment or choose distinct ports.
Simultaneous actions against the same target in one checkout are not isolated.

For an interactive session from that branch:

```bash
npx @kotarcreative/biodome up local --build
npx @kotarcreative/biodome shell local
# Exit the shell; the environment stays running.
npx @kotarcreative/biodome down local
```

`shell` currently supports Docker Compose, inherits terminal I/O, and runs as the
runtime user. Other providers reject it explicitly. An external agent can also
use `exec`, `logs`, `status`, and optional authenticated MCP access.

## Migrating from embedded agent tasks

- Remove `addOpencodeHarness`, `addPiHarness`, `addCodexHarness`,
  `addClaudeHarness`, and `addLlmProvider` declarations.
- Move `.biodome/tasks/<name>.mjs` to `.biodome/actions/<name>.mjs`.
- Replace `addTask({ harness, prompt, artifacts })` with
  `addAction({ command, intent, input, outputs })`.
- Keep languages, services, apps, processes, environment variables, and lifecycle
  hooks. Browser tooling remains available through `computerUse()`; its
  `manualQaTask()` agent-prompt helper was removed.
- Execution plans now use version 2. The package exposes `buildActionPlan()` and
  `ActionSpec`; older internal task/run terminology does not imply an embedded
  agent.

Deployment IDs now include the checkout path. Stop environments built by the old
version before upgrading; old deployment state is intentionally not silently
adopted by the new identity scheme.

Configuration and recipe modules are trusted host-side JavaScript. Neither a
worktree nor the word "sandbox" makes untrusted configuration safe to execute.
