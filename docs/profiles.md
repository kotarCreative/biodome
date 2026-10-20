# Environment profiles

A target chooses runtime infrastructure. A profile chooses a named setup for an
experiment. An action chooses the check to run. Profiles are optional; without
`--profile`, existing environment loading and target identities are unchanged.

## Declare a setup

Profiles are data-only JSON files in `.biodome/profiles/`. For example,
`.biodome/profiles/staging.json`:

```json
{
  "description": "Local frontend against the deployed QA API",
  "features": ["frontend", "browser"],
  "environment": {
    "VITE_API_URL": { "value": "https://qa-api.example.com", "scope": "both" },
    "QA_API_TOKEN": { "from": { "env": "QA_API_TOKEN" }, "required": true }
  }
}
```

- `features`, when present, is the **exact set of feature filenames** to load,
  without `.mjs` / `.js`. Files still load in alphabetical order. Missing,
  ambiguous, duplicate, and unsafe names are rejected. Omit it to keep all
  features; `[]` selects none. Excluded feature modules are not imported.
- `environment` explicitly replaces matching global `addEnv()` declarations or
  adds new ones, using the existing value/reference/default/scope contract. The
  whole declaration is replaced, not deep-merged: replacing a build/runtime
  literal with a runtime reference removes the old baked value from the plan.
- Base service, app, and selected feature declarations load first. Overrides
  apply before finalization. Conflicts **within the base environment** remain
  errors; a profile does not silently resolve contradictory feature declarations.
- Unknown JSON fields are errors, including misspelled environment options.

The first version selects feature files only. `.biodome/services.*` and app
modules remain unconditional. Put an optional local API/database declaration in
a feature if a deployed-API profile should omit it. Process-specific environment
values remain process-specific and can shadow a global variable; profiles do not
rewrite those values or arbitrary command strings.

## Drive the experiment loop

```bash
biodome profiles
biodome profiles --json
biodome plan local checkout-qa --profile staging --json
biodome run local checkout-qa --profile staging --stream
biodome run local checkout-qa --profile mock-errors --stream

biodome up local --profile staging --build
biodome shell local --profile staging
biodome down local --profile staging
```

`--profile` is an invocation-scoped global option: it works before or after the
subcommand. It is not an action input and does not mutate `process.env`.
The same selection applies to build/up/run/exec/shell/logs/status/restart/down.
`profiles` lists declarations without importing feature modules. Explicit plan
JSON includes the selected feature set and environment override declarations;
references remain references, not resolved credential values.

The library APIs accept the same selection:

```typescript
const plan = await buildActionPlan(root, "local", "checkout-qa", {
  profile: "staging",
});
```

## Isolation and reuse

Each target/profile pair has a stable, bounded runtime namespace, for example
`local--profile--staging-<hash>`. It is used for generated files, deployment IDs,
state, logs, run records, and collected artifacts. The hash distinguishes long
names that share a truncated prefix. The marker `--profile--` is reserved and
cannot appear in a user-authored target name.

The resolved plan includes a configuration fingerprint covering the profile
definition, resolved build/runtime declarations, and target configuration.
Build manifests and deployment state record it. Profile-aware action execution,
`up`, `exec`, `shell`, and `restart` reject stale configuration instead of
silently using the previous setup. A changed profile keeps the same namespace,
so its existing deployment remains reachable for cleanup:

```bash
# After editing a profile:
biodome down local --profile staging
biodome up local --profile staging --build
```

`down` and diagnostic commands do not require matching fingerprints. Keep the
profile definition valid and its target/provider available until cleanup;
deleting the profile or changing the runtime provider first is not a supported
recovery workflow. An action's cleanup policy still applies when it fails,
including when stale configuration is detected. There is no automatic migration
or background recreation of running setups.

Isolation is **not** a filesystem sandbox: profiles in one checkout share source
files and workspace outputs. Use separate output paths or separate worktrees for
concurrent writes. Explicit host ports can still conflict; profiles do not
allocate ports automatically. Same-profile concurrent actions are not isolated.

## Secrets and provenance

Use `from: { "env": "NAME" }` locally and inject the value through your shell,
CI, a secret-manager wrapper, or ignored `.biodome/.env`. ECS supports native
Secrets Manager / SSM ARN references through the existing environment contract.
Profiles do not add a secret-manager resolver or change provider support.

Fingerprints include declared references, **not the resolved values** of host
secrets. Rotation therefore requires explicitly recreating the environment;
Biodome cannot detect it from a profile fingerprint. Build-time public frontend
values still require the frontend to be rebuilt; runtime injection cannot
rewrite an existing browser bundle. Never put a privileged token in a public
frontend variable or a literal build value.

`profile.resolved` events, portable execution plans, and durable run records
identify the profile and fingerprint. Events list feature names and override
keys, not resolved secret values. These are configuration provenance, not a
source snapshot, dependency lock, or security attestation. Do not log secrets.

## Scope of this first version

No inheritance, profile stacking, automatic endpoint discovery, secret rotation,
production-write approvals, or policy enforcement is implemented. A profile named
`read-only` is not read-only unless the supplied credentials and application
actually enforce it. The external agent still owns the hypothesis, acceptance
criteria, and evidence review.

See [the runnable profile example](../examples/environment-profiles/README.md).
