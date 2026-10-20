# Environment actions

Biodome no longer embeds coding agents or manages agent workflows. Define your
environment with apps, features, and services; expose ordinary command hooks with
explicit intent, JSON input, and output files.

See [Environment actions](actions.md) for branch QA, performance tests,
interactive branch sessions, CLI options, runtime guarantees, and migration from
the old harness-based task API.

Targets still select Docker Compose, Docker Sandboxes, or experimental AWS ECS.
Commands are checked against provider capabilities before execution. Portable
declarations are not proof of enforcement: current targets do not implement
network allowlists or portable per-action resource limits. Docker Sandboxes
requires its prebuilt template/kit inputs; ECS supports uploaded workspaces and
S3 artifact delivery, not in-place interactive shells.
