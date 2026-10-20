import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { generateStartupScript } from "../../../docker/generators/startup.js";

function generatedSection(script: string, startMarker: string, endMarker: string): string {
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Generated shell section not found");
  return script.slice(start, end);
}

function generatedWait(script: string, failureMessage: string): string {
  const message = script.indexOf(failureMessage);
  const start = script.lastIndexOf("wait_deadline=", message);
  const endMarker = "\ndone";
  const end = script.indexOf(endMarker, message);
  if (message < 0 || start < 0 || end < 0) throw new Error("Generated wait not found");
  return script.slice(start, end + endMarker.length);
}

function executeShell(script: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("/bin/sh", ["-c", `set -e\n${script}`], {
    encoding: "utf8",
    env,
    timeout: 4_000,
  });
}

describe("generateStartupScript", () => {
  it("starts supervisord before pre-start hooks and post-start hooks after all daemons", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push(
      {
        name: "repo-sync-api",
        command: ["sh", "/workspace/.biodome-build/repos/api.sh"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.pre",
      },
      {
        name: "migrate",
        command: ["python", "manage.py", "migrate"],
        ports: [],
        environment: { DATABASE_URL: "postgres://db" },
        workingDir: "/workspace/apps/api",
        mode: "oneshot",
        startOn: "start.pre",
      },
      {
        name: "api",
        command: ["python", "manage.py", "runserver"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
      },
      {
        name: "announce",
        command: ["node", "ready.mjs"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.post",
      },
    );

    const script = generateStartupScript(plan)!;
    expect(script).toContain("cd /workspace/apps/api");
    expect(script).toContain(
      'setpriv --reuid="$BIODOME_RUNTIME_UID" --regid="$BIODOME_RUNTIME_GID" --clear-groups env \\\n      "HOME=${hook_home:-/root}" \\\n      env DATABASE_URL=\'postgres://db\' python manage.py migrate',
    );
    expect(script).toContain('chgrp "$BIODOME_RUNTIME_GID" /workspace/.biodome-build/logs');
    expect(script).toContain("chmod 2770 /workspace/.biodome-build/logs");
    expect(script.indexOf("supervisord -c")).toBeLessThan(script.indexOf("repo-sync-api"));
    expect(script.indexOf("repo-sync-api")).toBeLessThan(script.indexOf("start all"));
    expect(script.indexOf("start all")).toBeLessThan(script.indexOf("announce"));
  });

  it("points hook HOME at the mapped runtime identity instead of /root", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push(
      {
        name: "migrate",
        command: ["python", "manage.py", "migrate"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.pre",
      },
      {
        name: "api",
        command: ["node", "server.js"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
      },
    );

    const script = generateStartupScript(plan)!;
    const section = generatedSection(script, "[hook] migrate", "aborting startup");
    expect(section).toContain('hook_home="$(getent passwd "$BIODOME_RUNTIME_UID" | cut -d: -f6)"');
    expect(section).toContain('"HOME=${hook_home:-/root}"');
  });

  it("maps the runtime identity onto the workspace owner via environment overrides", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "api",
      command: ["node", "server.js"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const script = generateStartupScript(plan)!;
    expect(script).toContain('BIODOME_RUNTIME_UID="${BIODOME_RUNTIME_UID:-10001}"');
    expect(script).toContain('BIODOME_RUNTIME_GID="${BIODOME_RUNTIME_GID:-10001}"');
    expect(script).toContain('elif [ "$(id -g biodome)" != "$BIODOME_RUNTIME_GID" ]; then');
    expect(script).toContain('groupmod -g "$BIODOME_RUNTIME_GID" biodome');
    expect(script).toContain('usermod -u "$BIODOME_RUNTIME_UID" biodome');
  });

  it("runs ECS job-mode commands as the runtime identity and shuts down services", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "api",
      command: ["node", "server.js"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const script = generateStartupScript(plan)!;
    expect(script).toContain("rm -f /workspace/.biodome-build/ready");
    expect(script).toContain('if [ "${1:-}" = "--job" ]; then');
    expect(script).toContain(
      'setpriv --reuid="$BIODOME_RUNTIME_UID" --regid="$BIODOME_RUNTIME_GID" --clear-groups "$@" || job_status=$?',
    );
    expect(script).toContain(
      "supervisorctl -c /workspace/.biodome-build/supervisord.conf shutdown",
    );
    expect(script).toContain('exit "$job_status"');
    expect(script.indexOf("touch /workspace/.biodome-build/ready")).toBeLessThan(
      script.indexOf('if [ "${1:-}" = "--job" ]'),
    );
  });

  it("warns instead of failing when mapped ids collide with image accounts", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "api",
      command: ["node", "server.js"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const script = generateStartupScript(plan)!;
    // Base images ship their own low-numbered accounts; remapping must stay
    // best-effort so startup never aborts on a taken uid or gid.
    expect(script).toContain(
      "biodome: WARNING: gid $BIODOME_RUNTIME_GID is taken by $mapped_group; keeping built-in group id",
    );
    expect(script).toContain(
      "biodome: WARNING: uid $BIODOME_RUNTIME_UID is taken by $mapped_user; keeping built-in user id",
    );
    expect(script).toContain('mapped_group=$(getent group "$BIODOME_RUNTIME_GID" | cut -d: -f1)');
  });

  it("grants access with mode changes only, never recursive chown of the runtime tree", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "api",
      command: ["node", "server.js"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const script = generateStartupScript(plan)!;
    // Read access for every identity without touching host ownership.
    expect(script).toContain("chmod -R a+rX /workspace/.biodome-build");
    // Writable state is shared through the runtime group instead.
    expect(script).toContain('chgrp -R "$BIODOME_RUNTIME_GID" /workspace/.biodome-build/logs');
    expect(script).toContain("chmod -R g+rwX /workspace/.biodome-build/logs");
    expect(script).toContain(
      'install -d -o "$BIODOME_RUNTIME_UID" -g "$BIODOME_RUNTIME_GID" -m 0750 /home/biodome',
    );
    // Never a recursive ownership change of generated or host trees.
    expect(script).not.toContain("chown -R");
    expect(script).toContain(
      "biodome: WARNING: set BIODOME_RUNTIME_UID/BIODOME_RUNTIME_GID to this repository owner ids",
    );
  });

  it("prepares direct FUSE mount points for the mount identity", () => {
    const plan = createPlan("my-app");
    plan.runtime.volumes.push({
      name: "assets",
      type: "s3",
      bucket: "example-assets",
      target: "/workspace/assets",
      directMount: true,
    });
    plan.runtime.processes.push({
      name: "rclone-mount-assets",
      command: ["rclone", "mount", "s3:example-assets/", "/workspace/assets"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      identity: "mount",
    });

    const script = generateStartupScript(plan)!;
    expect(script).toContain("mkdir -p /workspace/assets");
    expect(script).toContain("chown 'biodome-mount:biodome-mount' /workspace/assets");
  });
  it("keeps a hook-only environment alive for subsequent task execution", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "setup",
      command: ["sh", "setup.sh"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.pre",
    });

    const script = generateStartupScript(plan)!;
    expect(script).toContain("touch /workspace/.biodome-build/ready");
    expect(script).toContain('if [ "${1:-}" = "--job" ]; then');
    expect(script).toContain("exec sleep infinity");
  });

  it("starts and health-checks bootstrap processes before pre-start hooks", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push(
      {
        name: "postgres-server",
        command: ["sh", "postgres.sh"],
        ports: [],
        environment: {},
        healthCheck: { type: "tcp", port: 5432 },
        mode: "daemon",
        startOn: "start.post",
        bootstrap: true,
      },
      {
        name: "migrate",
        command: ["python", "manage.py", "migrate"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.pre",
      },
    );

    const script = generateStartupScript(plan)!;
    expect(script.indexOf("start postgres-server")).toBeLessThan(script.indexOf("migrate"));
    expect(script).toContain("healthchecks/postgres-server.sh");
  });

  it("rejects hook names that are not safe identifiers", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "hook-$(curl evil)",
      command: ["sh", "setup.sh"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.pre",
    });

    expect(() => generateStartupScript(plan)).toThrow(/Invalid hook name/);
  });

  it("rejects environment variable names that are not safe identifiers", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "setup",
      command: ["sh", "setup.sh"],
      ports: [],
      environment: { "A; curl evil": "x" },
      mode: "oneshot",
      startOn: "start.pre",
    });

    expect(() => generateStartupScript(plan)).toThrow(/Invalid environment variable name/);
  });

  it("runs lifecycle hooks strictly in declaration order", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push(
      {
        name: "init-role",
        command: ["sh", "role.sh"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.pre",
      },
      {
        name: "migrate",
        command: ["sh", "migrate.sh"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.pre",
      },
      {
        name: "seed",
        command: ["sh", "seed.sh"],
        ports: [],
        environment: {},
        mode: "oneshot",
        startOn: "start.pre",
      },
    );

    const script = generateStartupScript(plan)!;
    // Each hook's failure guard precedes the next hook's launch, so no hook
    // can start before the previous one has finished.
    const initGuard = script.indexOf('hook "init-role" failed');
    const migrateLaunch = script.indexOf("[hook] migrate");
    const migrateGuard = script.indexOf('hook "migrate" failed');
    const seedLaunch = script.indexOf("[hook] seed");
    expect(initGuard).toBeGreaterThan(-1);
    expect(migrateLaunch).toBeGreaterThan(initGuard);
    expect(migrateGuard).toBeGreaterThan(migrateLaunch);
    expect(seedLaunch).toBeGreaterThan(migrateGuard);
    expect(script).not.toContain("&\nhook_pid");
  });

  it("aborts generated startup shell when a lifecycle hook command fails", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "flaky",
      command: ["false"],
      ports: [],
      environment: {},
      mode: "oneshot",
      startOn: "start.pre",
    });

    const script = generateStartupScript(plan)!;
    const hook = generatedSection(script, 'echo "[hook] flaky"', "exec sleep infinity");
    const result = executeShell(hook, { ...process.env, PATH: "/nonexistent" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('biodome: hook "flaky" failed; aborting startup');
  });

  it("aborts generated startup shell when a lifecycle hook working directory is missing", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "setup",
      command: ["true"],
      ports: [],
      environment: {},
      workingDir: "/biodome/does-not-exist",
      mode: "oneshot",
      startOn: "start.pre",
    });

    const script = generateStartupScript(plan)!;
    const hook = generatedSection(script, 'echo "[hook] setup"', "exec sleep infinity");
    const result = executeShell(hook, { ...process.env, PATH: "/nonexistent" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('biodome: hook "setup" failed; aborting startup');
  });

  it("aborts generated startup shell when `supervisorctl start all` fails", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push(
      {
        name: "api",
        command: ["node", "missing.js"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
      },
      {
        name: "after",
        command: ["true"],
        ports: [],
        environment: {},
        workingDir: "/tmp",
        mode: "oneshot",
        startOn: "start.post",
      },
    );

    const script = generateStartupScript(plan)!;
    const startAll = generatedSection(
      script,
      "if ! supervisorctl -c /workspace/.biodome-build/supervisord.conf start all",
      'wait "$supervisord_pid"',
    );
    const result = executeShell(`supervisorctl() { return 1; }\n${startAll}`, {
      ...process.env,
      PATH: "/nonexistent",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("one or more managed processes failed to start");
    expect(result.stderr).not.toContain("[hook] after");
  });

  it("bounds slow supervisor and bootstrap-health probes by elapsed wall-clock time", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "db-server",
      command: ["sh", "db.sh"],
      ports: [],
      environment: {},
      healthCheck: { type: "tcp", port: 5432 },
      mode: "daemon",
      startOn: "start.post",
      bootstrap: true,
    });

    const script = generateStartupScript(plan)!;
    const root = mkdtempSync(join(tmpdir(), "biodome-startup-wait-"));
    const bin = join(root, "bin");
    const healthcheck = join(root, "healthcheck.sh");
    mkdirSync(bin);
    writeFileSync(join(bin, "supervisorctl"), "#!/bin/sh\nexec sleep 30\n");
    writeFileSync(healthcheck, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "supervisorctl"), 0o755);
    chmodSync(healthcheck, 0o755);

    try {
      const waits = [
        generatedWait(script, "supervisord did not become ready within 60s").replace("+ 60", "+ 1"),
        generatedWait(script, 'bootstrap process "db-server" did not become healthy within 300s')
          .replace("+ 300", "+ 1")
          .replace("/workspace/.biodome-build/healthchecks/db-server.sh", healthcheck),
      ];

      for (const wait of waits) {
        const startedAt = performance.now();
        const result = executeShell(wait, {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("did not become");
        expect(performance.now() - startedAt).toBeLessThan(3_000);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(script).toContain('timeout -s KILL "$wait_remaining" supervisorctl');
    expect(script).toContain('timeout -s KILL "$wait_remaining" sh');
    expect(script).not.toContain("wait_attempts");
  });
});
