# Browser tooling recipe

`computerUse()` prepares Chromium, FFmpeg, Xvfb, and `agent-browser` in the
environment. It does not install a coding agent, provide a reasoning loop, or
generate a QA prompt. An external agent or project-owned test script drives the
tools through ordinary commands.

```javascript
// .biodome/apps/qa.mjs
import { computerUse } from "@kotarcreative/biodome/recipes/computer-use";

export default computerUse({
  baseUrl: "http://localhost:3000",
  allowedDomains: ["localhost"],
});
```

Declare an optional app endpoint reference as `target` to validate dependency
ordering. `headed: true` uses an Xvfb display; it does not expose a remote desktop.
Navigation is unrestricted if `allowedDomains` is omitted. Chromium currently
uses `--no-sandbox`, so use an isolated runtime and test accounts rather than
running this recipe directly on a trusted host.

```javascript
// .biodome/actions/screenshot.mjs
export default function screenshot(ctx) {
  ctx.addAction({
    command: [
      "sh",
      "-c",
      "mkdir -p qa && agent-browser open http://localhost:3000 && agent-browser screenshot qa/desktop.png && agent-browser close",
    ],
    intent: "Capture the branch UI for an external reviewer",
    outputs: ["qa/desktop.png"],
    cleanup: "never",
  });
}
```

Use project-owned Playwright/e2e scripts for deterministic checks. Screenshots,
recordings, traces, and browser output may contain sensitive application data;
use test accounts and appropriate retention. The previous `manualQaTask()` helper
and its embedded agent workflow were removed. See [actions](../actions.md).
