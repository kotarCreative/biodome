# Implementation Plan: Security, Performance, and Developer Ergonomics

Status: partially implemented. Tasks 1–4 (Oxlint/Oxfmt, dependency vulns,
McpConfig, MCP auth) and Task 6 (local proxy-volume containment) are complete.
Tasks 5 and 7–12 have significant remaining work; see "Remaining Work" below.

## Goal

Make Biodome safe to use with agent harnesses and remote storage, resilient
under normal concurrent use, and easier to develop and maintain.

The target state is:

- The MCP server has an explicit authentication and authorization boundary.
- Secret values are never written to generated plans, informational responses,
  or default telemetry logs.
- A compromised dev-container process cannot gain privileged host-equivalent
  access through the generated container configuration.
- File, provider, and event APIs have bounded resource usage.
- The repository has a fast, consistent formatter/linter/test/audit quality gate.

## Scope Decisions

- Use **Oxlint** and **Oxfmt**. Do not introduce ESLint, Prettier, or Biome.
- Preserve the current public primitives unless this plan explicitly changes
  their security defaults.
- Do not add compatibility paths for unauthenticated MCP clients. This is a
  security release; callers must provide the generated token.
- Prefer proxy cloud volumes over direct FUSE mounts. Direct cloud mounts remain
  supported only with reduced container privileges.
- Telemetry remains available, but sensitive payload capture must be opt-in.
- Add focused unit tests first. Add integration tests only where Docker or a
  real HTTP boundary is required.

## Baseline

Run this before Task 1 and record the result in the pull request:

```bash
npm ci
npm run typecheck
npm run test:run
npm audit --omit=dev
```

Current baseline: typecheck and 231 unit tests pass. `npm audit --omit=dev`
reports 8 production dependency vulnerabilities, including one high severity
finding in `fast-uri`.

---

## Task 1: Add Oxlint, Oxfmt, and Quality Scripts

Files: `package.json`, `package-lock.json`, `.oxlintrc.json`, `.oxfmtrc.json`,
`.github/workflows/ci.yml`

1. Install `oxlint` and `oxfmt` as development dependencies using npm. Do not
   install ESLint, Prettier, or formatter plugins.
2. Add these scripts to `package.json`:

   ```json
   {
     "format": "oxfmt --write .",
     "format:check": "oxfmt --check .",
     "lint": "oxlint .",
     "check": "npm run format:check && npm run lint && npm run typecheck && npm run test:run"
   }
   ```

3. Add `.oxlintrc.json`. Start with the recommended rules, TypeScript support,
   and `no-unused-vars` disabled because TypeScript already enforces unused
   locals and parameters. Add rule exceptions only when a concrete source file
   requires one; do not disable whole rule categories preemptively.
4. Add `.oxfmtrc.json` with the repository's existing style: two-space
   indentation, double quotes, semicolons, trailing commas where Oxfmt supports
   them, and LF line endings. Run Oxfmt and commit its mechanical formatting
   separately from behavior changes if it touches many files.
5. Add `npm run format:check` and `npm run lint` before typecheck in both CI
   jobs. The integration job may use `npm run check` before the Docker setup.

Acceptance criteria:

- `npm run format:check` passes on a clean checkout.
- `npm run lint` passes with no warnings ignored.
- `npm run check` passes locally.
- Pull-request CI fails if formatting, linting, types, or unit tests fail.

---

## Task 2: Update Vulnerable Production Dependencies

Files: `package.json`, `package-lock.json`, relevant adapter and MCP tests

1. Run `npm audit --omit=dev --json` and identify the current dependency paths
   for `fast-uri`, `@modelcontextprotocol/sdk` / `@hono/node-server`, `uuid`,
   and the Google Storage transitive dependencies.
2. Upgrade direct dependencies to releases that resolve those advisories. Start
   with `@modelcontextprotocol/sdk` and `@google-cloud/storage`; update other
   direct dependencies only when required by the resolved tree.
3. Use `npm install <package>@<version>` rather than editing the lockfile by
   hand. Do not use `npm audit fix --force`.
4. Inspect package release notes for MCP transport API changes and Google Cloud
   credential behavior changes. Adapt source only when compilation or tests
   identify an actual incompatibility.
5. Add an audit CI step after `npm ci` that fails on high or critical production
   vulnerabilities. Keep moderate findings visible but do not block CI until
   the team agrees on a policy.

Acceptance criteria:

- `npm audit --omit=dev` has no high or critical vulnerabilities.
- `npm run check` and `npm run test:integration` pass.
- The pull request documents any remaining moderate findings and their
  dependency owner.

---

## Task 3: Define the MCP Security Model and Configuration

Files: `src/core/plan.ts`, `src/core/context.ts`, `src/core/feature.ts`,
`src/mcp/generator.ts`, `src/docker/generator.ts`, `docs/api.md`,
`docs/processes.md`

1. Add an MCP configuration model with these explicit fields:

   ```ts
   interface McpConfig {
     enabled: boolean;
     token: SecretValue;
     allowExec?: boolean;
     allowProcessControl?: boolean;
     maxReadBytes?: number;
     maxWriteBytes?: number;
     maxListEntries?: number;
   }
   ```

2. Require `token` whenever MCP is enabled. It must be an environment reference
   (`{ env: "BIODOME_MCP_TOKEN" }`), not a literal string. Generate validation
   errors that name the invalid field and show the required form.
3. Default `allowExec` and `allowProcessControl` to `false`. `exec_command` and
   `restart_process` must not be advertised or callable unless enabled.
4. Choose conservative defaults for all three resource limits. Define named
   constants in one module rather than duplicating numeric literals. Use a
   small default for list results and a file limit suitable for MCP responses,
   not a container-sized limit.
5. Ensure the token environment variable reaches only the MCP daemon process,
   not all generated processes. Keep the token as an environment reference in
   `plan.json`; never resolve it while generating files.
6. Document the threat model: any code in the dev container can reach loopback,
   so loopback-only publication is not authentication. Explain how clients send
   `Authorization: Bearer <token>`.

Tests to add:

- Schema and context tests for missing token, literal token, valid env token,
  default disabled action capabilities, and configurable limits.
- Generator tests proving the token reference, not the value, appears in the
  generated compose/plan artifacts.

Acceptance criteria:

- An enabled MCP configuration without an environment-backed token is rejected.
- Default MCP configuration does not expose command execution or process restart.
- No generated artifact contains a resolved MCP token.

---

## Task 4: Authenticate and Authorize Every MCP Request

Files: `src/mcp/server.ts`, `src/tests/mcp/server.test.ts` (new),
`src/docker/generator.ts`

1. Extract request authentication into a small function in `server.ts` or a
   dedicated `src/mcp/auth.ts` module. Read the expected token once from the
   MCP process environment at startup.
2. Before `transport.handleRequest(req, res)`, reject every non-health request
   without an exact bearer token match. Use `timingSafeEqual` only after
   confirming equal buffer lengths. Return HTTP 401 without revealing why the
   credential was rejected.
3. Keep `/health` unauthenticated only if it returns a constant status and is
   needed by Docker health checks. It must not expose configuration, versions,
   or errors.
4. Bind the MCP HTTP listener to `127.0.0.1` inside the container unless a
   documented harness integration requires another interface. Keep host port
   publication loopback-only.
5. Enforce action capability checks in the call handler as defense in depth.
   Disabled tools must be absent from `ListTools` and return a method/permission
   error if a client invokes them directly.
6. Add graceful shutdown handlers for `SIGTERM` and `SIGINT` that close the HTTP
   server and upstream registry clients.

Tests to add:

- HTTP tests for missing, malformed, wrong, and correct authorization headers.
- A test that `/health` cannot reveal plan or credential data.
- Tool-list and direct-call tests for disabled `exec_command` and
  `restart_process`.
- A test confirming the listener host passed to `listen()` is loopback.

Acceptance criteria:

- An unauthenticated caller cannot reach MCP transport handlers or tools.
- Authenticated clients can use only their enabled tool capabilities.
- Shutdown closes open server and provider resources.

---

## Task 5: Remove Secret Disclosure and Harden Telemetry

Files: `src/mcp/generator.ts`, `src/mcp/server.ts`, `src/docker/generator.ts`,
`src/core/events.ts`, `src/tests/mcp/generator.test.ts`, new MCP tests

1. Inventory every credential-bearing field: endpoints, providers, volumes,
   repositories, LLM providers, harness API keys, and MCP token.
2. Reject literal strings for all credential-bearing public APIs. Allow only
   environment references or, if a future secret manager is added, typed secret
   references. Make the validation consistent across all primitives.
3. Change `get_sandbox_info`, `get_endpoints`, and `get_providers` to return
   credential metadata only, for example `{ token: { env: "TOKEN" } }` or
   `{ token: "REDACTED" }`. Never resolve and return the value.
4. Remove `resolveEndpoint` and `resolveProvider` behavior that exposes live
   environment values. Provider calls may still resolve the credential privately
   immediately before connecting upstream.
5. Change telemetry defaults to metadata-only events. Do not log prompts,
   command strings, tool arguments, tool output, hook stdin, or base64 content.
   Add a clearly named opt-in payload capture setting for debugging.
6. Apply redaction and maximum event-size limits before every log write. Store
   logs with mode `0600` and directories with mode `0700` where the platform
   permits it. Keep logs out of image build context.
7. Document that `--no-events` disables lifecycle events, and document the
   separate agent-telemetry payload setting.

Tests to add:

- Plan serialization tests that reject literal secrets for every primitive.
- MCP response snapshots proving no credential values appear.
- Telemetry tests that assert secrets, arguments, command text, and payloads
  are absent by default and redacted when opt-in capture is enabled.
- File-mode tests where portable; otherwise test explicit mode arguments.

Acceptance criteria:

- Repository search finds no API response that returns a resolved secret.
- Generated plans contain only secret references.
- Default logs do not contain request payloads or tool output.

---

## Task 6: Fix Local Proxy Volume Containment

Files: `src/mcp/volumes/local.ts`, `src/mcp/volumes/adapter.ts`,
`src/tests/mcp/volumes/local.test.ts` (new),
`src/tests/mcp/volumes/adapter.test.ts`

1. Replace the string-based `fullPath.replace(root, "")` check with a single
   containment helper.
2. Resolve both root and candidate paths with `path.resolve`. Reject an absolute
   user path before resolution. Allow only `candidate === root` or candidates
   beginning with `root + path.sep`.
3. Normalize the relative path before applying `allowedPaths`; never match a
   path that contains `.` or `..` path segments.
4. For existing paths, use `realpath` on the root and target before read, list,
   and stat, then repeat the containment check. This prevents a symlink inside
   the volume root from escaping it.
5. For writes, walk existing parent components with `lstat` and reject symlinks.
   Open the final file without following an existing symlink where Node and the
   platform support it. Do not create directories outside the verified root.
6. Change `allowedPaths` default behavior from allow-all to deny-all for proxy
   volumes. Require an explicit `allowedPaths` declaration such as `["**"]` for
   full access. Document this breaking security default.

Tests to add:

- `../`, nested traversal, absolute paths, and traversal that normalizes outside
  the root are rejected.
- Reads, writes, stats, and lists through an escaping symlink are rejected.
- Valid nested paths work.
- Omitted or empty `allowedPaths` is denied; explicit glob rules work.

Acceptance criteria:

- No user-controlled path can access outside the configured root.
- A local proxy volume cannot be accessed without explicit allowed paths.

---

## Task 7: Bound and Cache Proxy Volume Operations

Files: `src/mcp/server.ts`, `src/mcp/volumes/adapter.ts`,
`src/mcp/volumes/s3.ts`, `src/mcp/volumes/gcs.ts`,
`src/mcp/volumes/azure.ts`, volume tests

1. Extend the adapter API so `list` accepts `{ limit, cursor? }` and returns
   `{ files, nextCursor? }`. Do not fetch all pages before returning a result.
2. Implement S3 continuation-token handling with `NextContinuationToken`. Return
   an opaque cursor to the MCP client instead of silently truncating after 1,000
   objects.
3. Implement bounded page sizes for GCS and Azure. Do not accumulate every
   matching object in memory.
4. In GCS listing, use metadata returned by the listing API where available. If
   an extra request is unavoidable, use bounded concurrency, never serial
   unbounded requests.
5. Before reading a cloud object, obtain its content length where available and
   reject objects over `maxReadBytes`. Reject base64 request bodies whose encoded
   length cannot fit in `maxWriteBytes` before decoding them.
6. Return an explicit size-limit error that identifies the configured limit but
   does not disclose secret storage details.
7. Create adapters once per immutable volume configuration and cache them in the
   MCP server. Add an adapter cleanup contract for SDK clients that need it.
8. Keep the MCP response shape stable where practical. If pagination requires a
   shape change, version/document it and update tool schemas and descriptions.

Tests to add:

- S3 test for page one plus continuation token and page two.
- GCS/Azure tests for requested limit and next cursor.
- Tests rejecting oversized reads and writes before buffering their complete
  contents.
- Test that repeated requests for a volume reuse one adapter/client.

Acceptance criteria:

- No read, write, or list request can cause unbounded process memory use.
- A caller can page through every S3, GCS, and Azure result.
- Repeated volume requests reuse client connections.

---

## Task 8: Make MCP and Provider I/O Non-Blocking and Bounded

Files: `src/mcp/server.ts`, `src/mcp/upstream.ts`,
`src/tests/mcp/upstream.test.ts`, new MCP server tests

1. Replace `execSync`, `execFileSync`, `appendFileSync`, and synchronous plan
   reads in request paths with Promise-based Node APIs.
2. Implement command execution with `spawn` or `execFile`, a hard timeout,
   output byte limits, cancellation on client disconnect where practical, and
   process-tree termination. Continue to allow shell syntax only when
   `allowExec` is enabled; otherwise do not accept arbitrary commands.
3. Use an asynchronous serialized log writer or bounded queue. If the queue is
   full, drop telemetry with a counter rather than blocking action requests.
4. Add connect and request deadlines to upstream provider connections. Ensure
   failure messages do not include tokens or authorization headers.
5. Replace the partial-cache pattern in `listCatalog`. Store a shared in-flight
   refresh promise, build a new catalog locally, then atomically replace the
   completed cache. Return the previous completed cache during a refresh.
6. Fetch independent provider catalogs with bounded concurrency. Preserve
   deterministic output ordering by sorting entries after collection.
7. Do not retry unsafe upstream `provider_execute` calls automatically.

Tests to add:

- A long-running command does not block a status or health request.
- Timeout and output-limit behavior terminates the command and returns a bounded
  error.
- Concurrent catalog requests share one refresh and never observe a partial
  result.
- Slow providers time out while healthy providers remain visible.

Acceptance criteria:

- MCP request processing does not use synchronous filesystem or child-process
  APIs.
- One slow provider or command cannot block unrelated MCP requests.

---

## Task 9: Reduce Generated Container Privilege

Files: `src/docker/generator.ts`, `src/core/plan.ts`, `src/core/context.ts`,
`src/tests/docker/generator.test.ts`, integration tests, documentation

1. Change the generated dev service to run as a dedicated non-root user by
   default. Ensure `/workspace`, generated home directories, and required cache
   locations have the correct ownership.
2. Remove `privileged: true` for cloud volumes. Generate the smallest FUSE
   configuration needed: `/dev/fuse`, only required capabilities, dropped
   default capabilities, and `no-new-privileges` if compatible.
3. Do not use `--allow-other` for rclone/FUSE mounts unless an explicit,
   documented configuration flag enables it.
4. Keep proxy cloud volumes as the documented recommended option. Emit a clear
   validation warning for direct cloud mounts explaining their residual risk.
5. Re-evaluate supervisor configuration. It must not force daemon processes to
   run as root merely because supervisor starts as root.
6. Preserve service ports and developer usability. Test all supported language
   images and harnesses under the non-root user.

Tests to add:

- Generator tests assert `privileged` is absent for every configuration.
- Generator tests assert non-root user, dropped capabilities, and FUSE-only
  devices/capabilities for direct mounts.
- Docker integration test verifies a normal workspace command succeeds and the
  effective user is not root.

Acceptance criteria:

- Generated compose files never set `privileged: true`.
- Normal development workflows still work as a non-root user.

---

## Task 10: Harden Repository Sync

Files: `src/core/plan.ts`, `src/core/context.ts`, `src/docker/generator.ts`,
generator tests, documentation

1. Add an explicit SSH known-hosts configuration field. It must be a secret-free
   host key entry or a path/reference to a mounted known-hosts file.
2. Require known-hosts configuration for SSH repository URLs. Keep HTTPS token
   repositories working without it.
3. Generate a dedicated known-hosts file with mode `0600` and use:

   ```sh
   ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<path>
   ```

4. Remove `StrictHostKeyChecking=no` completely.
5. Ensure clone URL construction does not print HTTPS tokens in shell tracing or
   event payloads. Keep generated scripts `set -e`, not `set -x`.

Tests to add:

- SSH configuration without known hosts is rejected.
- Generated SSH script has strict checking and dedicated known-hosts path.
- Repository scripts never contain a resolved environment token.

Acceptance criteria:

- No generated script disables SSH host key verification.
- SSH repository sync is resistant to host impersonation.

---

## Task 11: Bound Event Storage and Improve the Events CLI

Files: `src/core/events.ts`, `src/cli/index.ts`, `src/tests/core/events.test.ts`,
CLI helper tests, documentation

1. Add event configuration for retention count and maximum file size. Use safe
   defaults that retain recent troubleshooting history without unlimited growth.
2. Rotate a run log before it exceeds the size limit. Never split one JSONL
   event across files.
3. Add `--limit <n>` to `biodome events`, defaulting to a bounded recent result
   set. Keep `--run` and apply it before loading unrelated historical logs.
4. For `--run`, compute only the matching run file path instead of reading every
   event log. For cross-run output, stream or process newest files first and
   stop once the limit is satisfied.
5. Decode event JSON through `SandboxEventSchema`; malformed lines should be
   reported with filename and line number while remaining valid events still
   display.
6. Avoid synchronous filesystem operations on paths used from long-running MCP
   server code. CLI-only synchronous access may remain if it is not on a server
   request path and keeps the implementation materially simpler.

Tests to add:

- Rotation retains valid JSONL boundaries.
- Default CLI output is limited.
- `--run` does not read unrelated files.
- Malformed event lines are handled predictably.

Acceptance criteria:

- Event storage cannot grow indefinitely by default.
- `biodome events` remains responsive with many historical run logs.

---

## Task 12: Documentation, Release Notes, and Final Verification

Files: `README.md`, `docs/index.md`, `docs/api.md`, `docs/processes.md`,
`docs/file-layout.md`, `SECURITY.md`, `.github/dependabot.yml` (new)

1. Add `SECURITY.md` with a supported-version policy, private reporting contact,
   expected response process, and immediate mitigation guidance for a leaked MCP
   token.
2. Update MCP documentation with authentication, authorization capabilities,
   secure configuration examples, token rotation procedure, limits, and the
   breaking changes to action tools and proxy allowed paths.
3. Update volume documentation with proxy-volume recommendation, explicit
   allowed paths, pagination, size limits, and direct-mount residual risk.
4. Update telemetry documentation with default metadata-only behavior, opt-in
   payload capture, retention, permissions, and deletion guidance.
5. Add Dependabot configuration for npm and GitHub Actions updates.
6. Add a concise migration section to README and release notes. Call out MCP
   token requirement, disabled default action tools, explicit proxy paths,
   non-root containers, and required SSH host verification.
7. Run the complete verification suite:

   ```bash
   npm run format:check
   npm run lint
   npm run typecheck
   npm run test:run
   npm run build
   npm run test:integration
   npm audit --omit=dev
   ```

8. Manually inspect a generated compose file and plan for a representative
   project. Confirm it contains no literal secrets, no privileged container,
   no disabled SSH host checking, and no MCP endpoint without authentication.

Acceptance criteria:

- Documentation matches actual defaults and migration behavior.
- All final verification commands pass.
- The release notes enumerate every security-default change.

## Pull Request Strategy

Create small, reviewable pull requests in this order:

1. Task 1: tooling and CI quality gate.
2. Task 2: dependency remediation.
3. Tasks 3 and 4: MCP security model, auth, and authorization.
4. Task 5: secret and telemetry hardening.
5. Tasks 6 and 7: proxy volume containment, limits, pagination, and caching.
6. Task 8: non-blocking MCP and provider I/O.
7. Tasks 9 and 10: container and repository hardening.
8. Task 11: event retention and CLI scalability.
9. Task 12: documentation, automation, and release validation.

Do not defer tests to a follow-up pull request. Each pull request must add tests
for the security or performance behavior it changes and must pass `npm run check`.

## Remaining Work

- **Task 5** (secret/telemetry hardening): Harness-level telemetry (OpenCode, Pi,
  Codex, Claude) still captures full prompts, args, and output by default. Needs
  metadata-only defaults + an opt-in payload capture setting.
- **Task 7** (volume pagination): `VolumeAdapter.list()` has no `{limit,
cursor?}` API. S3, GCS, and Azure adapters all fetch unbounded results before
  returning.
- **Task 8** (non-blocking I/O): `readFileSync` remains in MCP plan loading;
  `appendFileSync` + `existsSync` + `mkdirSync` remain in `logMcpEvent` (called
  on every tool invocation). No async bounded log queue.
- **Task 9** (container privilege): No non-root user set in generated compose
  files or Dockerfile. Supervisor runs as root. `--allow-other` is always passed
  to rclone. No validation warning for direct cloud mounts.
- **Task 10** (SSH hardening): Uses `StrictHostKeyChecking=accept-new` instead
  of `yes`. No user-facing known-hosts configuration field. No validation
  requiring known-hosts for SSH URLs.
- **Task 11** (event storage): Events are dropped when the log file exceeds max
  size instead of rotating. CLI `--limit` not implemented. `--run` reads all
  files and filters in memory. Malformed JSON lines crash the CLI events
  command.
- **Task 12** (docs/release): `SECURITY.md`, `dependabot.yml`, and migration
  guide for breaking changes are all missing.
