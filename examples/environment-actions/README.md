# Environment actions demo

No agent or external service credentials are required. From the repository root,
build Biodome with `npm run build`, then enter this directory:

```bash
node ../../dist/cli/index.js plan local e2e --json
node ../../dist/cli/index.js run local e2e --json
node ../../dist/cli/index.js run local performance --input '{"iterations":50}' --json
node ../../dist/cli/index.js shell local
node ../../dist/cli/index.js down local
```

The first run builds and starts the environment. These actions intentionally keep
it running for reuse and interactive investigation. Results are collected under
`.biodome-build/targets/local/artifacts/results/`. The scripts read JSON input and
output paths from the action contract; they do not interpret a prompt.

For another branch, use a separate Git worktree and run these commands there.
Stop the original environment first: both copies publish port 3137. Noisy shared
hardware and this tiny sequential test are not a production performance benchmark.
