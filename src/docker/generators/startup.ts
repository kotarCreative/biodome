import { identitiesOf, type Plan, type Process, type RuntimeIdentity } from "../../core/plan.js";
import { assertIdentifier, generatedRuntimeDir, shellQuote, supervisorLogDir } from "./shell.js";

function runtimeIdentityOf(plan: Plan): RuntimeIdentity {
  const identity = identitiesOf(plan).find((candidate) => candidate.role === "runtime");
  if (!identity) throw new Error("Plan is missing the runtime identity");
  return identity;
}

function mountIdentityOf(plan: Plan): RuntimeIdentity | undefined {
  return identitiesOf(plan).find((candidate) => candidate.role === "mount");
}

/**
 * Emits the bounded, narrowly scoped initialization that lets supervisord start
 * elevated only to prepare paths and setuid programs:
 *  - map the runtime identity onto the workspace bind-mount owner via
 *    BIODOME_RUNTIME_UID/GID when shadow tools are available,
 *  - grant non-root identities read access to the generated tree with mode
 *    changes only (never recursive chown: the tree may be a host bind mount
 *    whose ownership must stay with the host user),
 *  - make container-owned writable state (logs, harness homes) group-shared,
 *  - warn deterministically when the workspace remains unwritable.
 */
function initializeIdentities(lines: string[], plan: Plan): void {
  const runtime = runtimeIdentityOf(plan);
  const q = shellQuote;
  const runtimeDir = generatedRuntimeDir(plan);
  const logDir = supervisorLogDir(plan);

  lines.push(
    "# Map the runtime identity onto the workspace owner without rebuilding.",
    `BIODOME_RUNTIME_UID="\${BIODOME_RUNTIME_UID:-${runtime.uid}}"`,
    `BIODOME_RUNTIME_GID="\${BIODOME_RUNTIME_GID:-${runtime.gid}}"`,
    "if command -v groupmod >/dev/null 2>&1 && command -v usermod >/dev/null 2>&1; then",
    '  mapped_group=$(getent group "$BIODOME_RUNTIME_GID" | cut -d: -f1)',
    `  if [ -n "$mapped_group" ] && [ "$mapped_group" != "${runtime.group}" ]; then`,
    `    echo "biodome: WARNING: gid $BIODOME_RUNTIME_GID is taken by $mapped_group; keeping built-in group id" >&2`,
    `  elif [ "$(id -g ${q(runtime.user)})" != "$BIODOME_RUNTIME_GID" ]; then`,
    `    groupmod -g "$BIODOME_RUNTIME_GID" ${q(runtime.group)}`,
    "  fi",
    '  mapped_user=$(getent passwd "$BIODOME_RUNTIME_UID" | cut -d: -f1)',
    `  if [ -n "$mapped_user" ] && [ "$mapped_user" != "${runtime.user}" ]; then`,
    `    echo "biodome: WARNING: uid $BIODOME_RUNTIME_UID is taken by $mapped_user; keeping built-in user id" >&2`,
    `  elif [ "$(id -u ${q(runtime.user)})" != "$BIODOME_RUNTIME_UID" ]; then`,
    `    usermod -u "$BIODOME_RUNTIME_UID" ${q(runtime.user)}`,
    "  fi",
    "else",
    "  echo 'biodome: WARNING: usermod/groupmod unavailable; keeping built-in identity ids' >&2",
    "fi",
    "",
    "# Narrow fixups: biodome-owned paths only, never an arbitrary host tree.",
    `install -d -o "$BIODOME_RUNTIME_UID" -g "$BIODOME_RUNTIME_GID" -m 0750 ${q(`/home/${runtime.user}`)}`,
  );

  // Named cache volumes are docker-managed (not host bind mounts), so their
  // top-level dirs can safely become runtime-owned; contents are created by
  // the runtime identity itself.
  lines.push(
    "for cache_dir in node_modules .venv vendor; do",
    '  if [ -d "/workspace/$cache_dir" ]; then',
    `    chown "$BIODOME_RUNTIME_UID:$BIODOME_RUNTIME_GID" "/workspace/$cache_dir"`,
    "  fi",
    "done",
  );

  // Read access for every identity via modes alone: no ownership changes on
  // possibly host-owned files. Intermediate directories are rendered 0700, so
  // each ancestor of the scoped runtime dir must be traversable too.
  const ancestors: string[] = [];
  let prefix = runtimeDir;
  while (prefix !== "/workspace" && prefix !== "/") {
    prefix = prefix.slice(0, prefix.lastIndexOf("/")) || "/";
    if (prefix !== "/workspace" && prefix !== "/") ancestors.push(prefix);
  }
  lines.push(
    ...(ancestors.length > 0 ? [`chmod a+rX ${ancestors.reverse().map(q).join(" ")}`] : []),
    `if [ -d ${q(runtimeDir)} ]; then`,
    `  chmod -R a+rX ${q(runtimeDir)}`,
    "fi",
  );

  // Writable state lives in biodome-generated directories. Sharing happens
  // through the runtime group so the host owner is never replaced.
  lines.push(`mkdir -p ${q(logDir)}`);
  const writableStateDirs = [
    logDir,
    ...["opencode-homes", "pi-homes", "codex-homes", "claude-homes"].map(
      (dir) => `${runtimeDir}/${dir}`,
    ),
  ];
  for (const stateDir of writableStateDirs) {
    lines.push(`if [ -d ${q(stateDir)} ]; then`);
    lines.push(`  chgrp -R "$BIODOME_RUNTIME_GID" ${q(stateDir)}`);
    lines.push(`  chmod -R g+rwX ${q(stateDir)}`);
    lines.push("fi");
  }
  lines.push(`chgrp "$BIODOME_RUNTIME_GID" ${q(logDir)}`, `chmod 2770 ${q(logDir)}`);

  const mount = mountIdentityOf(plan);
  if (mount) {
    for (const volume of plan.runtime.volumes) {
      if (volume.type === "local" || volume.proxy || !volume.directMount) continue;
      assertIdentifier(volume.name, "volume name");
      lines.push(`mkdir -p ${shellQuote(volume.target)}`);
      lines.push(
        `chown ${shellQuote(`${mount.user}:${mount.group}`)} ${shellQuote(volume.target)}`,
      );
    }
  }

  lines.push(
    "if command -v setpriv >/dev/null 2>&1; then",
    `  if ! setpriv --reuid="$BIODOME_RUNTIME_UID" --regid="$BIODOME_RUNTIME_GID" --clear-groups \\`,
    "      test -w /workspace >/dev/null 2>&1; then",
    "    echo 'biodome: WARNING: /workspace is not writable by the runtime identity;' >&2",
    "    echo 'biodome: WARNING: set BIODOME_RUNTIME_UID/BIODOME_RUNTIME_GID to this repository owner ids' >&2",
    "  fi",
    "fi",
    "",
  );
}

function hookCommand(hook: Process): string {
  const environment = Object.entries(hook.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `${assertIdentifier(key, "environment variable name")}=${shellQuote(value)}`,
    );
  const command = hook.command.map(shellQuote).join(" ");
  const invocation = environment.length > 0 ? `env ${environment.join(" ")} ${command}` : command;
  const workingDir = shellQuote(hook.workingDir ?? "/workspace");
  // Hooks are user-controlled workloads: run them as the mapped runtime
  // identity instead of root. Root startup must fail closed when the image
  // cannot perform the identity transition. HOME is pointed at the runtime
  // identity's passwd entry (startup still runs with HOME=/root), so
  // HOME-sensitive tools such as git do not read or warn about /root/.config.
  return `(
  cd ${workingDir} || exit 1
  if command -v setpriv >/dev/null 2>&1; then
    hook_home="$(getent passwd "$BIODOME_RUNTIME_UID" | cut -d: -f6)"
    setpriv --reuid="$BIODOME_RUNTIME_UID" --regid="$BIODOME_RUNTIME_GID" --clear-groups env \\
      "HOME=\${hook_home:-/root}" \\
      ${invocation}
  else
    echo 'biodome: setpriv unavailable; refusing to run a lifecycle hook as root' >&2
    exit 1
  fi
)`;
}

/**
 * Emits lifecycle hooks in strict declaration order: each hook runs to
 * completion before the next begins, so ordered lifecycle steps (init role,
 * then migrate, then seed...) are guaranteed. A failed hook aborts startup so
 * later hooks and managed workloads cannot run against partial initialization.
 */
function emitHooks(lines: string[], hooks: Process[]): void {
  for (const hook of hooks) {
    assertIdentifier(hook.name, "hook name");
    lines.push(`echo "[hook] ${hook.name}" >&2`);
    lines.push(`if ! ${hookCommand(hook)}; then`);
    lines.push(`  echo ${shellQuote(`biodome: hook "${hook.name}" failed; aborting startup`)} >&2`);
    lines.push("  exit 1");
    lines.push("fi");
    lines.push("");
  }
}

const SUPERVISOR_READY_TIMEOUT_SECONDS = 60;
const BOOTSTRAP_HEALTH_TIMEOUT_SECONDS = 300;
const WAIT_POLL_INTERVAL = "0.1";

/** Emits a wall-clock-bounded wait whose individual probes cannot hang past the deadline. */
function boundedWait(
  lines: string[],
  options: { condition: string; timeoutSeconds: number; failureMessage: string },
): void {
  lines.push(
    `wait_deadline=$(( $(date +%s) + ${options.timeoutSeconds} ))`,
    "while :; do",
    "  wait_now=$(date +%s)",
    '  if [ "$wait_now" -ge "$wait_deadline" ]; then',
    `    echo ${shellQuote(`biodome: ${options.failureMessage}`)} >&2`,
    "    exit 1",
    "  fi",
    "  wait_remaining=$((wait_deadline - wait_now))",
    `  if timeout -s KILL "$wait_remaining" ${options.condition}; then`,
    "    break",
    "  fi",
    '  if [ "$(date +%s)" -ge "$wait_deadline" ]; then',
    `    echo ${shellQuote(`biodome: ${options.failureMessage}`)} >&2`,
    "    exit 1",
    "  fi",
    `  sleep ${WAIT_POLL_INTERVAL}`,
    "done",
  );
}

function startSupervisor(lines: string[], plan: Plan): void {
  initializeIdentities(lines, plan);
  const config = `${generatedRuntimeDir(plan)}/supervisord.conf`;
  const quotedConfig = shellQuote(config);
  lines.push(
    // supervisord does not create missing log directories; ownership and mode
    // for the private runtime and log dirs were set during identity init.
    `supervisord -c ${quotedConfig} &`,
    "supervisord_pid=$!",
  );
  boundedWait(lines, {
    condition: `supervisorctl -c ${quotedConfig} pid >/dev/null 2>&1`,
    timeoutSeconds: SUPERVISOR_READY_TIMEOUT_SECONDS,
    failureMessage: `supervisord did not become ready within ${SUPERVISOR_READY_TIMEOUT_SECONDS}s; check ${supervisorLogDir(plan)}/supervisord.log`,
  });
  lines.push("");
}

function startBootstrapProcesses(lines: string[], plan: Plan): void {
  const config = shellQuote(`${generatedRuntimeDir(plan)}/supervisord.conf`);
  for (const process of plan.runtime.processes) {
    if (process.mode !== "daemon" || !process.bootstrap) continue;
    assertIdentifier(process.name, "process name");
    // A nonzero exit here means supervisord rejected the spawn outright (bad
    // command, missing file); failing immediately is louder than burning the
    // full health timeout below.
    lines.push(
      `if ! supervisorctl -c ${config} start ${shellQuote(process.name)}; then`,
      `  echo ${shellQuote(`biodome: failed to launch bootstrap process "${process.name}"`)} >&2`,
      "  exit 1",
      "fi",
    );
    if (process.healthCheck) {
      boundedWait(lines, {
        condition: `sh ${shellQuote(`${generatedRuntimeDir(plan)}/healthchecks/${process.name}.sh`)} >/dev/null 2>&1`,
        timeoutSeconds: BOOTSTRAP_HEALTH_TIMEOUT_SECONDS,
        failureMessage: `bootstrap process "${process.name}" did not become healthy within ${BOOTSTRAP_HEALTH_TIMEOUT_SECONDS}s`,
      });
    }
  }
  if (plan.runtime.processes.some((process) => process.mode === "daemon" && process.bootstrap)) {
    lines.push("");
  }
}

function emitJobMode(lines: string[], plan: Plan, shutdownSupervisor: boolean): void {
  lines.push(
    'if [ "${1:-}" = "--job" ]; then',
    "  shift",
    '  if [ "$#" -eq 0 ]; then',
    "    echo 'biodome: --job requires a command' >&2",
    "    exit 1",
    "  fi",
    "  job_status=0",
    "  if command -v setpriv >/dev/null 2>&1; then",
    '    setpriv --reuid="$BIODOME_RUNTIME_UID" --regid="$BIODOME_RUNTIME_GID" --clear-groups "$@" || job_status=$?',
    "  else",
    "    echo 'biodome: setpriv unavailable; refusing to run a job as root' >&2",
    "    job_status=1",
    "  fi",
  );
  if (shutdownSupervisor) {
    lines.push(
      `  supervisorctl -c ${shellQuote(`${generatedRuntimeDir(plan)}/supervisord.conf`)} shutdown >/dev/null 2>&1 || true`,
      '  wait "$supervisord_pid" || true',
    );
  }
  lines.push('  exit "$job_status"', "fi", "");
}

/** Whether this plan needs the generated container startup entrypoint. */
export function needsStartupScript(plan: Plan): boolean {
  return plan.runtime.processes.some(
    (process) =>
      process.mode === "daemon" ||
      (process.mode === "oneshot" &&
        (process.startOn === "start.pre" || process.startOn === "start.post")),
  );
}

/** Runs container lifecycle hooks around supervisord without involving the host CLI. */
export function generateStartupScript(plan: Plan): string | undefined {
  const preHooks = plan.runtime.processes.filter(
    (process) => process.mode === "oneshot" && process.startOn === "start.pre",
  );
  const postHooks = plan.runtime.processes.filter(
    (process) => process.mode === "oneshot" && process.startOn === "start.post",
  );
  const hasDaemons = plan.runtime.processes.some((process) => process.mode === "daemon");
  if (!needsStartupScript(plan)) return undefined;

  const lines = [
    "#!/bin/sh",
    "set -e",
    `rm -f ${shellQuote(`${generatedRuntimeDir(plan)}/ready`)}`,
    "",
  ];
  if (!hasDaemons) {
    initializeIdentities(lines, plan);
    emitHooks(lines, preHooks);
    emitHooks(lines, postHooks);
    lines.push(`touch ${shellQuote(`${generatedRuntimeDir(plan)}/ready`)}`, "");
    emitJobMode(lines, plan, false);
    lines.push("exec sleep infinity", "");
    return lines.join("\n");
  }

  startSupervisor(lines, plan);
  startBootstrapProcesses(lines, plan);
  emitHooks(lines, preHooks);
  lines.push(
    `if ! supervisorctl -c ${shellQuote(`${generatedRuntimeDir(plan)}/supervisord.conf`)} start all; then`,
    "  echo 'biodome: one or more managed processes failed to start; check the supervisor logs for details' >&2",
    "  exit 1",
    "fi",
    "",
  );
  emitHooks(lines, postHooks);
  lines.push(`touch ${shellQuote(`${generatedRuntimeDir(plan)}/ready`)}`, "");
  emitJobMode(lines, plan, true);
  lines.push('wait "$supervisord_pid"', "");
  return lines.join("\n");
}
