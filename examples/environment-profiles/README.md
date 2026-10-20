# Same check, different environment setups

This dependency-free example runs a small Node HTTP frontend facade against
either a healthy API or a mock API returning 503. It demonstrates setup selection,
not browser UI coverage or a production deployment.

From this directory, using a built Biodome CLI:

```bash
node ../../dist/cli/index.js profiles
node ../../dist/cli/index.js plan local qa --profile local --json
node ../../dist/cli/index.js run local qa --profile local --output results/local.json --stream
node ../../dist/cli/index.js run local qa --profile mock-errors --output results/errors.json --stream
```

Both runs use the same action. The `local` profile loads `frontend` + `local-api`;
`mock-errors` loads `frontend` + `error-api`, pointing `API_URL` to its different
port and changing the expected response state. QA verifies both the handling
state and the actual upstream status, so a connection failure cannot masquerade
as a verified HTTP 503 response.

No host ports are published, allowing both profiles to run at once. They retain
their environments (`cleanup: "never"`) for investigation:

```bash
node ../../dist/cli/index.js shell local --profile mock-errors
node ../../dist/cli/index.js down local --profile local
node ../../dist/cli/index.js down local --profile mock-errors
```

For a deliberately failing theory, supply `--input '{"expectedState":"ready"}'`
to the `mock-errors` run. Its available report is collected before failure is
returned. After editing a profile, explicitly stop and rebuild that setup;
execution against an older fingerprint is rejected.

To point a real frontend at a deployed API, select only its frontend/browser
features and override its API URL with the deployed address. Wire that variable
into the frontend's actual build/runtime configuration and account for browser
CORS and authentication. This demo intentionally uses local APIs so it requires
no external service or credentials.

See [profiles](../../docs/profiles.md) for semantics, secrets, and limitations.
