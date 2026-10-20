import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTargetPlan, buildTargetPlanEffect, buildTaskPlan } from "../../builder/index.js";
import {
  assertProfileManifest,
  assertProfileState,
  listProfiles,
  ProfileSelection,
  profileTargetName,
} from "../../core/profiles.js";
import { compileExecutionPlan, executionPlanDigest } from "../../orchestration/compiler.js";
import { readState, writeState } from "../../runtime/state.js";

describe("named environment profiles", () => {
  let root: string;
  const write = (path: string, content: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const profile = (name: string, value: unknown) =>
    write(`.biodome/profiles/${name}.json`, JSON.stringify(value));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "biodome-profiles-"));
    write(".biodome/config.json", JSON.stringify({ project: { name: "profiles-test" } }));
    write(".biodome/targets/local.mjs", 'export default ctx => ctx.useRuntime("docker-compose");');
    write(
      ".biodome/features/frontend.mjs",
      `export default ctx => {
      ctx.addEnv("API_URL", {value:"http://localhost:8080",scope:"both"});
      ctx.addProcess({name:"frontend",command:["node","server.mjs"]});
    };`,
    );
    write(
      ".biodome/features/backend.mjs",
      'export default ctx => ctx.addProcess({name:"backend",command:["node","api.mjs"]});',
    );
    write(
      ".biodome/actions/qa.mjs",
      'export default ctx => ctx.addAction({command:["node","qa.mjs"],intent:"Verify the same journey"});',
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves unprofiled behavior and selects features before evaluation", async () => {
    const base = await buildTargetPlan(root, "local");
    expect(base.profile).toBeUndefined();
    expect(base.deployment?.target.name).toBe("local");
    expect(base.runtime.processes.map((entry) => entry.name).sort()).toEqual([
      "backend",
      "frontend",
    ]);
    write(
      ".biodome/features/excluded.mjs",
      'throw new Error("must not evaluate excluded feature");',
    );
    profile("staging", {
      features: ["frontend"],
      environment: { API_URL: { value: "https://staging.example.com", scope: "runtime" } },
    });
    const staging = await buildTargetPlan(root, "local", { profile: "staging" });
    expect(staging.runtime.processes.map((entry) => entry.name)).toEqual(["frontend"]);
    expect(staging.runtime.environment.API_URL).toBe("https://staging.example.com");
    expect(staging.build.environment.API_URL).toBeUndefined();
    expect(staging.profile?.features).toEqual(["frontend"]);
    expect(staging.deployment?.target.name).toBe(profileTargetName("local", "staging"));
    expect(staging.deployment?.deploymentId).not.toBe(base.deployment?.deploymentId);
  });

  it("replaces literals with references without resolving or fingerprinting secret values", async () => {
    profile("qa", {
      environment: { API_URL: { from: { env: "BIODOME_PROFILE_TEST_SECRET" }, required: true } },
    });
    vi.stubEnv("BIODOME_PROFILE_TEST_SECRET", "first-private-value");
    const first = await buildTargetPlan(root, "local", { profile: "qa" });
    expect(first.runtime.envVars.find((entry) => entry.key === "API_URL")).toMatchObject({
      from: { env: "BIODOME_PROFILE_TEST_SECRET" },
      required: true,
    });
    expect(first.runtime.environment.API_URL).toBeUndefined();
    expect(first.build.environment.API_URL).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("first-private-value");
    vi.stubEnv("BIODOME_PROFILE_TEST_SECRET", "rotated-private-value");
    const second = await buildTargetPlan(root, "local", { profile: "qa" });
    expect(second.profile?.fingerprint).toBe(first.profile?.fingerprint);
  });

  it("isolates concurrent selections without changing process.env", async () => {
    const originalUrl = process.env.API_URL;
    profile("one", {
      features: ["frontend"],
      environment: { API_URL: { value: "https://one.example.com" } },
    });
    profile("two", {
      features: ["backend"],
      environment: { API_URL: { value: "https://two.example.com" } },
    });
    const [one, two] = await Promise.all(
      ["one", "two"].map((name) =>
        Effect.runPromise(
          buildTargetPlanEffect(root, "local").pipe(
            Effect.provideService(ProfileSelection, { name }),
          ),
        ),
      ),
    );
    expect(one.profile?.name).toBe("one");
    expect(two.profile?.name).toBe("two");
    expect(one.deployment?.deploymentId).not.toBe(two.deployment?.deploymentId);
    expect(one.deployment?.target.name).not.toBe(two.deployment?.target.name);
    expect(one.runtime.environment.API_URL).toBe("https://one.example.com");
    expect(two.runtime.environment.API_URL).toBe("https://two.example.com");
    expect(process.env.API_URL).toBe(originalUrl);
  });

  it("changes the fingerprint but retains cleanup ownership after profile edits", async () => {
    profile("qa", { environment: { API_URL: { value: "https://one.example.com" } } });
    const first = await buildTaskPlan(root, "local", "qa", { profile: "qa" });
    profile("qa", { environment: { API_URL: { value: "https://two.example.com" } } });
    const second = await buildTaskPlan(root, "local", "qa", { profile: "qa" });
    expect(second.profile?.fingerprint).not.toBe(first.profile?.fingerprint);
    expect(second.deployment?.deploymentId).toBe(first.deployment?.deploymentId);
    expect(second.deployment?.target.name).toBe(first.deployment?.target.name);
    expect(executionPlanDigest(compileExecutionPlan(second))).not.toBe(
      executionPlanDigest(compileExecutionPlan(first)),
    );
    const stale = await Effect.runPromise(
      Effect.result(assertProfileState(second, { profileFingerprint: first.profile?.fingerprint })),
    );
    expect(stale._tag).toBe("Failure");
    await Effect.runPromise(
      assertProfileState(second, { profileFingerprint: second.profile?.fingerprint }),
    );
    const staleImage = await Effect.runPromise(
      Effect.result(assertProfileManifest(second, { provider: {} })),
    );
    expect(staleImage._tag).toBe("Failure");
  });

  it("persists profile provenance with deployment state", async () => {
    profile("qa", {});
    const plan = await buildTargetPlan(root, "local", { profile: "qa" });
    const target = plan.deployment?.target.name;
    const id = plan.deployment?.deploymentId;
    if (!target || !id) throw new Error("Expected target");
    writeState(root, target, {
      driver: "docker-compose",
      deploymentId: id,
      createdAt: new Date().toISOString(),
      resourceIds: {},
      profileFingerprint: plan.profile?.fingerprint,
    });
    expect(readState(root, target, id, "docker-compose").profileFingerprint).toBe(
      plan.profile?.fingerprint,
    );
  });

  it("lists declarations without evaluating feature code", async () => {
    profile("staging", { description: "Deployed API", features: ["frontend"] });
    write(".biodome/features/frontend.mjs", 'throw new Error("must not evaluate");');
    expect(await Effect.runPromise(listProfiles(root))).toMatchObject([
      { name: "staging", description: "Deployed API" },
    ]);
  });

  it("allows an empty feature selection and preserves unconditional services modules", async () => {
    profile("empty", { features: [] });
    write(
      ".biodome/services.mjs",
      'export default ctx => ctx.addEnv("BASE_SETTING", {value:"retained"});',
    );
    const plan = await buildTargetPlan(root, "local", { profile: "empty" });
    expect(plan.profile?.features).toEqual([]);
    expect(plan.runtime.processes).toEqual([]);
    expect(plan.runtime.environment.BASE_SETTING).toBe("retained");
  });

  it("does not hide conflicts within base declarations", async () => {
    write(
      ".biodome/features/conflict.mjs",
      'export default ctx => ctx.addEnv("API_URL", {value:"conflicting"});',
    );
    profile("qa", { environment: { API_URL: { value: "profile-override" } } });
    await expect(buildTargetPlan(root, "local", { profile: "qa" })).rejects.toThrow(
      /Duplicate env variable/,
    );
  });

  it("bounds namespaces and distinguishes long names with the same prefix", () => {
    const first = profileTargetName("a".repeat(64), "p".repeat(64));
    const second = profileTargetName("a".repeat(64), "p".repeat(63) + "q");
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).not.toBe(second);
  });

  it.each([
    { features: ["missing"] },
    { features: ["frontend", "frontend"] },
    { features: ["../frontend"] },
    { enviroment: {} },
    { environment: { API_URL: { value: "x", unexpected: true } } },
  ])("rejects invalid profiles before starting resources: %j", async (definition) => {
    profile("bad", definition);
    await expect(buildTargetPlan(root, "local", { profile: "bad" })).rejects.toThrow();
  });

  it("rejects ambiguous feature files, missing profiles and unsafe names", async () => {
    profile("qa", { features: ["frontend"] });
    write(".biodome/features/frontend.js", "export default ctx => {};");
    await expect(buildTargetPlan(root, "local", { profile: "qa" })).rejects.toThrow(/ambiguous/);
    await expect(buildTargetPlan(root, "local", { profile: "missing" })).rejects.toThrow(
      /Invalid profile/,
    );
    await expect(buildTargetPlan(root, "local", { profile: "../outside" })).rejects.toThrow();
    expect(() => profileTargetName("local--profile--other", "qa")).toThrow(/reserved/);
  });
});
