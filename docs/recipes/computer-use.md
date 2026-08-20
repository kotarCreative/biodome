# Computer-use recipe

The built-in computer-use recipe equips an agent task to perform exploratory
manual QA against the code in its current workspace. It uses
[`agent-browser`](https://agent-browser.dev/) with Chromium for semantic browser
interaction and collects fixed evidence files that Biodome can return from every
built-in runtime provider.

Use this for branch validation, regression exploration, and acceptance checks.
Promote stable, repeatable flows to project-owned Playwright tests; the recipe is
optimized for an agent investigating a changing UI rather than for replacing a
deterministic test suite.

## Configure the browser

Declare the recipe as an implicit app. `baseUrl` must be the URL reachable from
inside the Biodome runtime. An app endpoint reference is optional, but including
one validates the dependency and orders app expansion.

```javascript
// .biodome/apps/qa.mjs
import { app } from "@kotarcreative/biodome/app";
import { computerUse } from "@kotarcreative/biodome/recipes/computer-use";

export default computerUse({
  baseUrl: "http://localhost:4200",
  target: app("web").endpoint("http"),
  allowedDomains: ["localhost"],
});
```

The recipe installs a checksum-verified `agent-browser` 0.34.0 glibc or musl
binary for Linux x64 or arm64, Chromium, FFmpeg for WebM recording, Xvfb, and
browser fonts. Debian- and Alpine-based language images are supported.
Ubuntu-based images (such as `eclipse-temurin` for Java) are rejected at build
time because they provide no installable Chromium package. It
configures a fixed session, output limits, prompt-injection boundary markers,
stable screenshot settings, and `/workspace/qa` as the evidence directory.

`allowedDomains` is optional. Set it whenever the application's required hosts
are known; include every application, API, authentication, and asset host the
journey needs. Entries are hostnames without schemes, ports, or paths, and the
list must include the `baseUrl` hostname. Omitting it leaves navigation
unrestricted. `headed: true` runs headed Chrome on an Xvfb virtual display; it
does not expose an interactive desktop. Headless mode is the default.

Chromium runs with `--no-sandbox` because Biodome's generated container runs as
root. Use the recipe only inside an isolated Biodome runtime, not directly on a
trusted host.

## Declare a manual QA task

Use `manualQaTask()` to pair the browser environment with a task. Instructions
should name the changed behavior, high-risk regressions, user journeys, and
acceptance criteria for the branch.

```javascript
// .biodome/tasks/manual-qa.mjs
import { manualQaTask } from "@kotarcreative/biodome/recipes/computer-use";

export default function manualQa(ctx) {
  ctx.addTask(
    manualQaTask({
      harness: "tester",
      instructions: `
Test the new checkout validation.
- Complete a successful checkout as a returning customer.
- Verify declined-card and missing-address errors.
- Confirm the form remains usable at mobile width.
`,
      requiredProcesses: ["web:web"],
      timeout: "30m",
    }),
  );
}
```

The selected harness must already be declared by a feature. Process names are
the qualified names shown by `biodome app inspect web` or `biodome info`.

Plan and run the task against the current branch:

```bash
biodome plan local manual-qa
biodome build local
biodome run local manual-qa
```

## Evidence contract

The helper declares explicit files rather than globs so collection is portable
across Docker Compose, Docker Sandboxes, and AWS ECS:

- `qa/report.md` - concise scope, scenario, issue, and evidence report.
- `qa/result.json` - structured `passed`, `failed`, or `blocked` result.
- `qa/desktop.png` and `qa/mobile.png` - full-page final-state screenshots.
- `qa/session.webm` - the complete browser interaction recording.
- `qa/network.har` - metadata-only network archive without response bodies.
- `qa/trace.json` - bounded Chrome trace for debugging behavior and timing.
- `qa/accessibility.json` - structured accessibility audit.
- `qa/console.json` and `qa/errors.json` - browser console and page errors.

The task prompt requires the agent to verify every file is non-empty in the same
workspace that produced it. This check deliberately does not use Biodome
`validationCommands`, because job-based providers run those commands in fresh
workspaces. A product defect is represented as `failed` in the report and JSON
while the agent task completes successfully, which preserves the evidence.
Browser/tool failures remain task failures.
Collected files are written under
`.biodome-build/targets/<target>/artifacts/qa/` and recorded in the run record.

Screenshots, recordings, traces, and network metadata can contain sensitive
application data. Use test accounts and non-production data, keep domain
allowlists narrow, and apply appropriate retention controls to the artifact
directory or remote artifact bucket.
