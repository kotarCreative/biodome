import { describe, expect, it } from "vitest";
import { generateSupervisordConf } from "../../../docker/generators/supervisor.js";
import { createPlan } from "../../../core/plan.js";

describe("generateSupervisordConf", () => {
  it("generates supervisord.conf for daemon processes", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("[program:django]");
    expect(conf).toContain("command=python manage.py runserver '0.0.0.0:8000'");
    expect(conf).toContain("[supervisord]");
  });

  it("writes all logs and supervisor state under the runtime log dir, never /tmp", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:8000/admin/login/",
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("logfile=/workspace/.biodome-build/logs/supervisord.log");
    expect(conf).toContain("pidfile=/workspace/.biodome-build/logs/supervisord.pid");
    expect(conf).toContain("file=/workspace/.biodome-build/logs/supervisor.sock");
    expect(conf).toContain("serverurl=unix:///workspace/.biodome-build/logs/supervisor.sock");
    expect(conf).toContain("stdout_logfile=/workspace/.biodome-build/logs/django.log");
    expect(conf).toContain("stderr_logfile=/workspace/.biodome-build/logs/django.log");
    expect(conf).toContain("stdout_logfile=/workspace/.biodome-build/logs/django-healthcheck.log");
    expect(conf).not.toContain("/tmp/");
  });

  it("scopes log paths to the deployment target's runtime dir", () => {
    const plan = createPlan("my-app");
    plan.deployment = {
      target: { name: "dev", driver: "docker-compose", options: {} },
      deploymentId: "my-app-dev",
    };
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("stdout_logfile=/workspace/.biodome-build/targets/dev/logs/django.log");
    expect(conf).toContain('BIODOME_LOG_DIR="/workspace/.biodome-build/targets/dev/logs"');
    expect(conf).not.toContain("/tmp/");
  });

  it("injects the log dir into every program environment for server-side resolution", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "worker",
      command: ["node", "worker.js"],
      ports: [],
      environment: { A_KEY: "value" },
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain(
      'environment=A_KEY="value",BIODOME_LOG_DIR="/workspace/.biodome-build/logs"',
    );
  });

  it("generates supervisord healthcheck programs and RPC config", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver", "0.0.0.0:8000"],
      ports: [{ host: 8000, container: 8000 }],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      healthCheck: {
        type: "http",
        url: "http://localhost:8000/admin/login/",
        interval: "5s",
        timeout: "3s",
        retries: 10,
      },
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("[unix_http_server]");
    expect(conf).toContain("[supervisorctl]");
    expect(conf).toContain("[rpcinterface:supervisor]");
    expect(conf).toContain("[program:django-healthcheck]");
    expect(conf).toContain("sh /workspace/.biodome-build/healthchecks/django-monitor.sh");
  });

  it("expands env placeholder values through supervisord instead of passing them literally", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "mcp",
      command: ["node", "server.js"],
      ports: [],
      environment: {
        MCP_TOKEN: "${MCP_TOKEN}",
        RCLONE_SFTP_PASS: "${RCLONE_SFTP_PASS}",
        PLAIN: "a'b%c",
      },
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain('MCP_TOKEN="%(ENV_MCP_TOKEN)s"');
    expect(conf).toContain('RCLONE_SFTP_PASS="%(ENV_RCLONE_SFTP_PASS)s"');
    expect(conf).not.toContain('"${MCP_TOKEN}"');
    expect(conf).not.toContain("${RCLONE_SFTP_PASS}");
    expect(conf).toContain(`PLAIN="a'b%%c"`);
  });

  it("quotes every command argument before supervisord re-parses it", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "evil",
      command: ["sh", "-c", "echo $(id) && curl http://x;y"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("command=sh -c 'echo $(id) && curl http://x;y'");
  });

  it("rejects process names that are not safe identifiers", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "web; rm -rf /",
      command: ["node", "server.js"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    expect(() => generateSupervisordConf(plan)).toThrow(/Invalid process name/);
  });

  it("runs user workloads as the runtime identity and never as root", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("[program:django]\ncommand=python manage.py runserver");
    expect(conf).toContain("user=biodome");
    // Only supervisord itself and biodome-owned health monitors may be root.
    const programSections = conf.split("[program:").slice(1);
    for (const section of programSections) {
      const isMonitor = section.startsWith("django-healthcheck]");
      expect(section).toMatch(isMonitor ? /user=root/ : /user=biodome/);
    }
  });

  it("runs MCP and mount-helper programs under their own identities", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push(
      {
        name: "biodome-mcp",
        command: ["node", "server.js"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
        identity: "mcp",
      },
      {
        name: "rclone-mount-assets",
        command: ["rclone", "mount", "s3:bucket/", "/workspace/assets"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
        identity: "mount",
      },
    );

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("[program:biodome-mcp]\ncommand=node server.js\nuser=biodome-mcp");
    expect(conf).toContain(
      "[program:rclone-mount-assets]\ncommand=rclone mount 's3:bucket/' /workspace/assets\nuser=biodome-mount",
    );
  });

  it("grants the supervisor socket to the shared runtime group instead of root only", () => {
    const plan = createPlan("my-app");
    plan.runtime.processes.push({
      name: "django",
      command: ["python", "manage.py", "runserver"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain("chmod=0770");
    expect(conf).toContain("chown=root:biodome");
  });

  it("runs in-container postgres under its dedicated package system user", () => {
    const plan = createPlan("my-app");
    plan.runtime.services.push({
      name: "db",
      type: "postgres",
      environment: {},
      ports: [],
    });
    plan.runtime.processes.push({
      name: "db-server",
      command: ["sh", "/workspace/.biodome-build/services/db.sh"],
      ports: [],
      environment: {},
      mode: "daemon",
      startOn: "start.post",
      bootstrap: true,
    });

    const conf = generateSupervisordConf(plan);
    expect(conf).toContain(
      "[program:db-server]\ncommand=sh /workspace/.biodome-build/services/db.sh\nuser=postgres",
    );
  });

  it("marks service servers RUNNING immediately; readiness is gated by the bootstrap health wait", () => {
    const plan = createPlan("my-app");
    plan.runtime.services.push({
      name: "db",
      type: "postgres",
      environment: {},
      ports: [],
    });
    plan.runtime.processes.push(
      {
        name: "db-server",
        command: ["sh", "/workspace/.biodome-build/services/db.sh"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
        bootstrap: true,
      },
      {
        name: "web",
        command: ["node", "server.js"],
        ports: [],
        environment: {},
        mode: "daemon",
        startOn: "start.post",
      },
    );

    const conf = generateSupervisordConf(plan);
    const dbSection = conf.slice(
      conf.indexOf("[program:db-server]"),
      conf.indexOf("[program:web]"),
    );
    expect(dbSection).toContain("startsecs=0");
    const webSection = conf.slice(conf.indexOf("[program:web]"));
    expect(webSection).not.toContain("startsecs=0");
  });
});
