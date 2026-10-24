import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const CLI_PATH = join(REPOSITORY_ROOT, "dist/cli/index.js");
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const CLI_TIMEOUT_MS = 8 * 60 * 1000;
const PROJECT_NAME = "biodome-local-task-fixture";
const TARGET_NAME = "local";
const TASK_NAME = "review-pr";
const PRIVATE_PROMPT = "PRIVATE_FIXTURE_PROMPT_DO_NOT_PRINT";
const ARTIFACT_BODY = [
  "source: ok",
  "dependency: ok",
  "daemon: ok",
  "environment: ok",
  "action-input: ok",
  "working-directory: ok",
  "",
].join("\n");

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

function hasDocker(): boolean {
  const result = spawnSync("docker", ["version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: OUTPUT_LIMIT_BYTES,
  });
  return result.status === 0;
}

function deploymentId(project: string, target: string, rootDir: string): string {
  const slug = `${project}-${target}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const hash = createHash("sha256")
    .update(`${slug}\0${resolve(rootDir)}`)
    .digest("hex")
    .slice(0, 8);
  return `${slug.slice(0, 48)}-${hash}`;
}

function writeFixtureFile(rootDir: string, path: string, content: string): void {
  const fullPath = join(rootDir, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function createFixture(rootDir: string): void {
  const files: Record<string, string> = {
    ".biodome/config.json": `${JSON.stringify({ project: { name: PROJECT_NAME } }, null, 2)}\n`,
    ".biodome/services.mjs": "export default function services() {}\n",
    ".biodome/features/dev.mjs": `
export default function dev(ctx) {
  ctx.addLanguage("node", { version: "20" });
  ctx.addEnv("FIXTURE_RUNTIME_VALUE", { value: "runtime-environment-ok" });
  ctx.addEnv("PATH", {
    value: "/workspace/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  });
  ctx.addProcess({
    name: "fixture-daemon",
    command: ["npm", "run", "daemon"],
    healthCheck: {
      type: "http",
      url: "http://localhost:4317/health",
      interval: "1s",
      timeout: "1s",
      retries: 10,
      startPeriod: "1s",
    },
  });
  ctx.addProcess({
    name: "fixture-worker",
    command: ["node", "worker.mjs"],
    workingDir: "/workspace/src",
  });
  ctx.addHook({
    name: "fixture-setup",
    command: ["node", "-e", "require('node:fs').writeFileSync('/workspace/hook-marker', JSON.parse(process.env.BIODOME_ACTION_INPUT).value)"],
    startOn: "start.pre",
    intent: "Prepare the branch fixture",
    input: { value: "hook-ready" },
    outputs: ["hook-marker"],
  });
}
`,
    ".biodome/targets/local.mjs": `
export default function local(ctx) {
  ctx.useRuntime("docker-compose");
}
`,
    ".biodome/actions/review-pr.mjs": `
export default function reviewPr(ctx) {
  ctx.addAction({
    command: ["node", "/workspace/bin/check.mjs"],
    intent: "Verify this branch environment",
    input: { assignment: ${JSON.stringify(PRIVATE_PROMPT)} },
    outputs: ["review.md"],
    timeout: "30s",
    cleanup: "always",
  });
}
`,
    "package.json": `${JSON.stringify(
      {
        name: PROJECT_NAME,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { daemon: "node src/daemon.mjs" },
        dependencies: { picocolors: "1.1.1" },
      },
      null,
      2,
    )}\n`,
    "package-lock.json": `${JSON.stringify(
      {
        name: PROJECT_NAME,
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: PROJECT_NAME,
            version: "1.0.0",
            dependencies: { picocolors: "1.1.1" },
          },
          "node_modules/picocolors": {
            version: "1.1.1",
            resolved: "https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz",
            integrity:
              "sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==",
            license: "ISC",
          },
        },
      },
      null,
      2,
    )}\n`,
    "src/app.mjs": 'export const applicationMarker = "workspace-source-ok";\n',
    "src/daemon.mjs": `
import { createServer } from "node:http";

createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("daemon-ready:" + process.pid + ":" + process.getuid());
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(4317, "127.0.0.1");
`,
    "src/worker.mjs": `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
  setTimeout(() => {
    writeFileSync("/workspace/worker-shutdown", "graceful");
    process.exit(0);
  }, 200);
});

// Proves supervisord started this daemon inside its workingDir: with a
// misquoted directory value the spawn fails and this endpoint never answers.
// Serves over HTTP (instead of writing a marker file) because single-language
// images may already own uid 1000, leaving the bind-mounted workspace
// read-only for the generated runtime identity.
createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(\`worker-cwd-ok:\${process.cwd()}\`);
}).listen(4318, "127.0.0.1");
`,
    "bin/check.mjs": `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import pc from "picocolors";

if (process.getuid() === 0) throw new Error("action unexpectedly runs as root");
if (process.env.HOME !== "/home/biodome") throw new Error("action HOME is not runtime-owned");
for (const path of ["/workspace", "/workspace/node_modules", process.env.HOME]) accessSync(path, constants.W_OK);
const cache = mkdtempSync("/workspace/node_modules/.write-check-");
rmSync(cache, { recursive: true });

if (JSON.parse(process.env.BIODOME_ACTION_INPUT).assignment !== ${JSON.stringify(PRIVATE_PROMPT)}) {
  throw new Error("Action input was not delivered");
}

const source = await readFile("/workspace/src/app.mjs", "utf8");
if (!source.includes("workspace-source-ok")) throw new Error("workspace source unavailable");
if (typeof pc.green !== "function") throw new Error("installed dependency unavailable");
if (process.env.FIXTURE_RUNTIME_VALUE !== "runtime-environment-ok") {
  throw new Error("runtime environment unavailable");
}
if ((await readFile("/workspace/hook-marker", "utf8")) !== "hook-ready") {
  throw new Error("start hook did not complete before task execution");
}

let daemonReady = false;
let daemonIdentity = "";
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:4317/health");
    daemonIdentity = await response.text();
    daemonReady = response.ok && daemonIdentity.startsWith("daemon-ready:");
  } catch {}
  if (daemonReady) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!daemonReady) throw new Error("managed daemon unavailable");
if (!daemonIdentity.endsWith(":" + process.getuid())) throw new Error("daemon/action identity mismatch");
execFileSync("supervisorctl", ["-c", "/workspace/.biodome-build/targets/local/supervisord.conf", "restart", "fixture-daemon"], { timeout: 30000 });
let restarted = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:4317/health");
    const identity = await response.text();
    restarted = response.ok && identity.startsWith("daemon-ready:") && identity !== daemonIdentity;
  } catch {}
  if (restarted) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!restarted) throw new Error("restart left an orphaned child holding the old port");

let workerCwd = "";
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:4318/");
    if (response.ok) workerCwd = await response.text();
  } catch {}
  if (workerCwd === "worker-cwd-ok:/workspace/src") break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (workerCwd !== "worker-cwd-ok:/workspace/src") {
  throw new Error("workingDir daemon did not start in its directory");
}

await writeFile("/workspace/review.md", ${JSON.stringify(ARTIFACT_BODY)});
`,
  };

  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    writeFixtureFile(rootDir, path, content.trimStart());
  }
  chmodSync(join(rootDir, "bin/check.mjs"), 0o755);
}

function runCli(rootDir: string): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, "--no-events", "run", TARGET_NAME, TASK_NAME, "--json"],
      {
        cwd: rootDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputExceeded = false;

    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const remaining = OUTPUT_LIMIT_BYTES - current.length;
      if (remaining <= 0) return current;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (stream === "stdout") stdout = append(stdout, chunk);
      else stderr = append(stderr, chunk);
      if (stdout.length + stderr.length >= OUTPUT_LIMIT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CLI_TIMEOUT_MS);
    timer.unref();

    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        outputExceeded,
      });
    });
  });
}

function removeComposeProject(rootDir: string): void {
  const composePath = join(rootDir, ".biodome-build/targets/local/docker-compose.yaml");
  if (!existsSync(composePath)) return;
  spawnSync(
    "docker",
    [
      "compose",
      "-f",
      composePath,
      "-p",
      deploymentId(PROJECT_NAME, TARGET_NAME, rootDir),
      "down",
      "--volumes",
      "--remove-orphans",
    ],
    {
      cwd: rootDir,
      stdio: "ignore",
      timeout: 60_000,
    },
  );
}

function expectGracefulStop(rootDir: string): void {
  const name = `${deploymentId(PROJECT_NAME, TARGET_NAME, rootDir)}-dev`;
  const start = performance.now();
  const stopped = spawnSync("docker", ["stop", name], { encoding: "utf8", timeout: 20_000 });
  expect(stopped.status, stopped.stderr).toBe(0);
  // Docker's default grace period stays at ten seconds. This distinguishes
  // genuine signal handling from simply shortening that period and force killing.
  expect(performance.now() - start).toBeLessThan(5_000);
  const inspected = spawnSync("docker", ["inspect", "--format", "{{json .State}}", name], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(inspected.status, inspected.stderr).toBe(0);
  expect(JSON.parse(inspected.stdout)).toMatchObject({
    Running: false,
    ExitCode: 0,
    OOMKilled: false,
  });
  expect(existsSync(join(rootDir, ".biodome-build/targets/local/ready"))).toBe(false);
}

const describeDocker = hasDocker() ? describe : describe.skip;

describeDocker("built CLI local task execution", () => {
  let fixtureRoot: string | undefined;

  beforeAll(() => {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: OUTPUT_LIMIT_BYTES,
    });
    expect(build.status, `CLI build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);
    expect(existsSync(CLI_PATH)).toBe(true);
  }, 130_000);

  afterEach(() => {
    if (!fixtureRoot) return;
    removeComposeProject(fixtureRoot);
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  });

  it(
    "initializes a command-only workspace before non-root execution",
    async () => {
      fixtureRoot = join(tmpdir(), `biodome-command-only-${process.pid}-${Date.now()}`);
      createFixture(fixtureRoot);
      writeFixtureFile(
        fixtureRoot,
        ".biodome/features/dev.mjs",
        `export default function dev(ctx) { ctx.addLanguage("node", { version: "20" }); }\n`,
      );
      writeFixtureFile(
        fixtureRoot,
        "bin/check.mjs",
        `
import { writeFileSync, accessSync, constants, mkdtempSync, rmSync } from "node:fs";
if (process.getuid() === 0) throw new Error("command-only action is root");
if (process.env.HOME !== "/home/biodome") throw new Error("incorrect HOME");
for (const path of ["/workspace", "/workspace/node_modules", process.env.HOME]) accessSync(path, constants.W_OK);
const cache = mkdtempSync("/workspace/node_modules/.write-check-");
rmSync(cache, { recursive: true });
writeFileSync("/workspace/review.md", "command-only-ready");
`,
      );
      const up = spawnSync(
        process.execPath,
        [CLI_PATH, "--no-events", "up", TARGET_NAME, "--build"],
        { cwd: fixtureRoot, encoding: "utf8", timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      expect(up.status, `${up.stdout}\n${up.stderr}`).toBe(0);
      expectGracefulStop(fixtureRoot);
      const result = await runCli(fixtureRoot);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const actionResult = JSON.parse(result.stdout);
      expect(readFileSync(actionResult.artifacts[0].localPath, "utf8")).toBe("command-only-ready");
      expect(existsSync(join(fixtureRoot, ".biodome-build/targets/local/state.json"))).toBe(false);
    },
    CLI_TIMEOUT_MS + 30_000,
  );

  it(
    "runs an ordinary action in the complete environment and returns only its artifact",
    async () => {
      fixtureRoot = join(tmpdir(), `biodome-local-task-${process.pid}-${Date.now()}`);
      createFixture(fixtureRoot);

      const invoke = (args: string[]) =>
        spawnSync(process.execPath, [CLI_PATH, "--no-events", ...args], {
          cwd: fixtureRoot,
          encoding: "utf8",
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
      const up = invoke(["up", TARGET_NAME, "--build"]);
      expect(up.status, `${up.stdout}\n${up.stderr}`).toBe(0);
      const exec = invoke([
        "exec",
        TARGET_NAME,
        "node",
        "-e",
        "if(process.getuid()===0)process.exit(9);console.log('exec-nonroot:'+process.env.HOME)",
      ]);
      expect(exec.status, `${exec.stdout}\n${exec.stderr}`).toBe(0);
      expect(exec.stdout).toContain("exec-nonroot:/home/biodome");
      const version = invoke(["exec", TARGET_NAME, "node", "--version"]);
      expect(version.status, `${version.stdout}\n${version.stderr}`).toBe(0);
      expect(version.stdout).toMatch(/^v20\./);
      const failedExec = invoke([
        "exec",
        TARGET_NAME,
        "node",
        "-e",
        "console.log('partial-output');process.stderr.write('failed-check');process.exit(17)",
      ]);
      expect(failedExec.status).not.toBe(0);
      expect(failedExec.stdout).toContain("partial-output");
      expect(failedExec.stderr).toContain("failed-check");
      expect(failedExec.stderr).toContain("exit code 17");

      expectGracefulStop(fixtureRoot);
      expect(readFileSync(join(fixtureRoot, "worker-shutdown"), "utf8")).toBe("graceful");

      const result = await runCli(fixtureRoot);
      const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(result.timedOut, diagnostics).toBe(false);
      expect(result.outputExceeded, diagnostics).toBe(false);
      expect(result.exitCode, diagnostics).toBe(0);
      const actionResult = JSON.parse(result.stdout);
      expect(actionResult.exitCode).toBe(0);
      expect(actionResult.artifacts[0].path).toBe("review.md");

      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain(TARGET_NAME);
      expect(output).toContain(TASK_NAME);
      expect(output).toContain("review.md");
      expect(output).not.toContain(PRIVATE_PROMPT);
      expect(output).not.toContain("pi-homes/reviewer/task");
      expect(output).not.toContain(ARTIFACT_BODY.trim());

      const targetDir = join(fixtureRoot, ".biodome-build/targets/local");
      const artifactPath = actionResult.artifacts[0].localPath;
      expect(readFileSync(artifactPath, "utf8")).toBe(ARTIFACT_BODY);
      expect(existsSync(join(targetDir, "state.json"))).toBe(false);

      const composePs = spawnSync(
        "docker",
        [
          "compose",
          "-f",
          join(targetDir, "docker-compose.yaml"),
          "-p",
          deploymentId(PROJECT_NAME, TARGET_NAME, fixtureRoot),
          "ps",
          "-q",
          "dev",
        ],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
          maxBuffer: OUTPUT_LIMIT_BYTES,
        },
      );
      expect(composePs.status, composePs.stderr).toBe(0);
      expect(composePs.stdout.trim()).toBe("");
    },
    CLI_TIMEOUT_MS + 30_000,
  );
});
