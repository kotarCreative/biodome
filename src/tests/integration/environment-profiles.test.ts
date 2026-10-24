import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repository = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const cli = join(repository, "dist/cli/index.js");
const docker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10000 }).status === 0;

function run(
  root: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

(docker ? describe : describe.skip)("profile-aware local environments", () => {
  let root: string | undefined;
  beforeAll(() => {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: repository,
      encoding: "utf8",
      timeout: 120000,
    });
    expect(build.status, build.stderr).toBe(0);
  }, 130000);
  afterEach(async () => {
    if (!root) return;
    for (const profile of ["local", "mock-errors"])
      await run(root, ["down", "local", "--profile", profile]);
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }, 130000);

  it("runs the same action in isolated setups, rejects stale reuse, and cleans up after edits", async () => {
    root = mkdtempSync(join(tmpdir(), "biodome-profile-live-"));
    // Match an ordinary checkout's traversal permissions for supervised users.
    chmodSync(root, 0o755);
    cpSync(join(repository, "examples/environment-profiles"), root, { recursive: true });
    // Actions write into the bind mount; keep the output directory host-owned
    // so the test controller can remove it after both profile environments stop.
    mkdirSync(join(root, "results"));
    const plans = await Promise.all(
      ["local", "mock-errors"].map((profile) =>
        run(root ?? "", ["plan", "local", "qa", "--profile", profile, "--json"]),
      ),
    );
    for (const plan of plans) expect(plan.code, plan.stderr).toBe(0);
    expect(JSON.parse(plans[0].stdout).profile.features).toEqual(["frontend", "local-api"]);
    expect(JSON.parse(plans[1].stdout).profile.features).toEqual(["error-api", "frontend"]);

    const results = await Promise.all(
      ["local", "mock-errors"].map((profile) =>
        run(root ?? "", [
          "run",
          "local",
          "qa",
          "--profile",
          profile,
          "--output",
          `results/${profile}.json`,
          "--json",
        ]),
      ),
    );
    for (const result of results) expect(result.code, result.stderr).toBe(0);
    const healthy = JSON.parse(results[0].stdout);
    const errors = JSON.parse(results[1].stdout);
    expect(healthy.run.profile.name).toBe("local");
    expect(errors.run.profile.name).toBe("mock-errors");
    expect(healthy.run.target).not.toBe(errors.run.target);
    expect(healthy.eventLogPath).toContain(healthy.run.target);
    expect(JSON.parse(readFileSync(healthy.artifacts[0].localPath, "utf8"))).toMatchObject({
      passed: true,
      observed: { state: "ready", upstreamStatus: 200 },
    });
    expect(JSON.parse(readFileSync(errors.artifacts[0].localPath, "utf8"))).toMatchObject({
      passed: true,
      observed: { state: "unavailable", upstreamStatus: 503 },
    });
    expect(readFileSync(healthy.eventLogPath, "utf8")).toContain('"type":"profile.resolved"');

    const definitionPath = join(root, ".biodome/profiles/local.json");
    const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
    definition.environment.API_URL.value = "http://127.0.0.1:9999";
    writeFileSync(definitionPath, JSON.stringify(definition));
    const stale = await run(root, ["run", "local", "qa", "--profile", "local", "--json"]);
    expect(stale.code).not.toBe(0);
    expect(JSON.parse(stale.stdout).error).toContain("configuration changed");
    const staleExec = await run(root, [
      "exec",
      "--profile",
      "local",
      "local",
      "--",
      "node",
      "-e",
      'console.log("must-not-run")',
    ]);
    expect(staleExec.code).not.toBe(0);
    expect(staleExec.stdout).not.toContain("must-not-run");
    expect(staleExec.stderr).toContain("configuration changed");
    const stopped = await run(root, ["down", "local", "--profile", "local"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(existsSync(join(root, ".biodome-build/targets", healthy.run.target, "state.json"))).toBe(
      false,
    );
    expect(existsSync(join(root, ".biodome-build/targets", errors.run.target, "state.json"))).toBe(
      true,
    );
    const repeat = await run(root, [
      "run",
      "local",
      "qa",
      "--profile",
      "mock-errors",
      "--output",
      "results/repeat.json",
      "--json",
    ]);
    expect(repeat.code, repeat.stderr).toBe(0);
  }, 240000);
});
