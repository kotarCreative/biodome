import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { generateStartupScript } from "../../../docker/generators/startup.js";

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
      'setpriv --reuid="$BIODOME_RUNTIME_UID" --regid="$BIODOME_RUNTIME_GID" --clear-groups env DATABASE_URL=\'postgres://db\' python manage.py migrate',
    );
    expect(script).toContain('chgrp "$BIODOME_RUNTIME_GID" /workspace/.biodome-build/logs');
    expect(script).toContain("chmod 2770 /workspace/.biodome-build/logs");
    expect(script.indexOf("supervisord -c")).toBeLessThan(script.indexOf("repo-sync-api"));
    expect(script.indexOf("repo-sync-api")).toBeLessThan(script.indexOf("start all"));
    expect(script.indexOf("start all")).toBeLessThan(script.indexOf("announce"));
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
    plan.runtime.agentHarnesses.push({
      name: "agent",
      type: "opencode",
      port: 3002,
      mcpServers: {},
      telemetry: { enabled: true, path: "/workspace/.biodome-build/logs/agent.jsonl" },
      config: {},
    });

    const script = generateStartupScript(plan)!;
    // Read access for every identity without touching host ownership.
    expect(script).toContain("chmod -R a+rX /workspace/.biodome-build");
    // Writable state is shared through the runtime group instead.
    expect(script).toContain(
      'chgrp -R "$BIODOME_RUNTIME_GID" /workspace/.biodome-build/opencode-homes',
    );
    expect(script).toContain("chmod -R g+rwX /workspace/.biodome-build/opencode-homes");
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

    expect(generateStartupScript(plan)).toContain("exec sleep infinity");
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
});
