import { describe, expect, it } from "vitest";
import { ProcessBuilder } from "../../../core/plan-builder/processes.js";
import { createPlan } from "../../../core/plan.js";
import { spawnSync } from "node:child_process";

function makeBuilder() {
  const plan = createPlan("test");
  const aptPackages: string[] = [];
  return {
    plan,
    aptPackages,
    builder: new ProcessBuilder(plan, (name) => aptPackages.push(name)),
  };
}

describe("ProcessBuilder", () => {
  it("adds daemon processes with normalized ports and working directories", () => {
    const { builder, plan } = makeBuilder();
    builder.addProcess({
      name: "api",
      command: ["node", "server.js"],
      port: 3000,
      ports: { debug: 9229 },
      workingDir: "apps/api",
    });

    expect(plan.runtime.processes).toEqual([
      expect.objectContaining({
        name: "api",
        mode: "daemon",
        startOn: "start.post",
        workingDir: "/workspace/apps/api",
        ports: [
          { host: 3000, container: 3000 },
          { name: "debug", host: 9229, container: 9229 },
        ],
      }),
    ]);
  });

  it("adds hooks as oneshot processes", () => {
    const { builder, plan } = makeBuilder();
    builder.addHook({ name: "migrate", command: ["npm", "run", "migrate"], startOn: "start.post" });

    expect(plan.runtime.processes[0]).toMatchObject({ mode: "oneshot", startOn: "start.post" });
  });

  it("delivers hook intent, input, and outputs without shell interpolation or global environment leakage", () => {
    const { builder, plan } = makeBuilder();
    const input = { route: "$(echo not-executed)\ncheckout" };
    builder.addHook({
      name: "seed",
      startOn: "start.pre",
      intent: "Prepare QA data",
      input,
      outputs: ["results/seed.json"],
      command: [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify([process.env.BIODOME_ACTION_INTENT, process.env.BIODOME_ACTION_INPUT, process.env.BIODOME_ACTION_OUTPUTS]))",
      ],
    });
    const command = plan.runtime.processes[0].command;
    const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "Prepare QA data",
      JSON.stringify(input),
      '["results/seed.json"]',
    ]);
    expect(plan.runtime.environment).toEqual({});
    expect(() =>
      builder.addHook({
        name: "invalid",
        startOn: "start.pre",
        command: ["true"],
        outputs: ["../escape"],
      }),
    ).toThrow();
  });

  it("rejects invalid ports and duplicate process names", () => {
    const { builder } = makeBuilder();
    expect(() => builder.addProcess({ name: "api", command: ["node"], port: 70000 })).toThrow(
      /integer between 1 and 65535/,
    );
    builder.addProcess({ name: "api", command: ["node"] });
    expect(() =>
      builder.addHook({ name: "api", command: ["npm", "run", "build"], startOn: "build.pre" }),
    ).toThrow(/Duplicate process or hook name/);
  });

  it("adds health-check dependencies and defaults HTTP URLs to the process port", () => {
    const { builder, plan, aptPackages } = makeBuilder();
    builder.addProcess({ name: "web", command: ["node"], port: 3000, healthCheck: {} });
    builder.addProcess({
      name: "tcp",
      command: ["node"],
      healthCheck: { type: "tcp", port: 4000 },
    });

    expect(plan.runtime.processes[0].healthCheck).toMatchObject({
      type: "http",
      url: "http://localhost:3000",
      port: 3000,
    });
    expect(aptPackages).toEqual(["curl", "netcat-openbsd"]);
  });

  it("keeps process environments scoped unless merging is explicitly requested", () => {
    const { builder, plan } = makeBuilder();
    plan.runtime.envVars.push({ key: "DECLARED", scope: "runtime", value: "one" });
    plan.runtime.environment.DECLARED = "one";
    builder.addProcess({
      name: "private",
      command: ["node"],
      environment: { PRIVATE: "four" },
    });
    builder.addProcess({
      name: "web",
      command: ["node"],
      environment: { DECLARED: "two", PROCESS: "three" },
      mergeEnv: true,
    });

    expect(plan.runtime.environment).toEqual({ DECLARED: "one", PROCESS: "three" });
  });

  it("defaults every process to the runtime identity unless overridden", () => {
    const { builder, plan } = makeBuilder();
    builder.addProcess({ name: "web", command: ["node"] });
    builder.addProcess({ name: "helper", command: ["node"], identity: "mount" });

    expect(plan.runtime.processes[0].identity).toBeUndefined();
    expect(plan.runtime.processes[1].identity).toBe("mount");
  });
});
