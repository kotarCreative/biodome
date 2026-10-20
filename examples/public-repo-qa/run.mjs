#!/usr/bin/env node
// An external controller, not an agent installed in a guest. Repository code
// and dependency installation execute only inside Biodome's Docker runtime.
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../dist/cli/index.js");
const root = resolve(process.argv[2] ?? "/tmp/opencode/biodome-public-qa");
const fixtures = join(here, "fixtures");
const projects = [
  {
    name: "todomvc",
    repository: "tastejs/todomvc",
    revision: "ff43b02e59dfa604386bb382034b2cd07c2bcd8a",
    command: ["node", ".biodome/qa/check.mjs"],
    fixture: "todomvc-qa.mjs",
    outputs: ["qa/result.json", "qa/desktop.png", "qa/mobile.png"],
  },
  {
    name: "express",
    repository: "expressjs/express",
    revision: "0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8",
    command: ["node", ".biodome/qa/check.mjs"],
    fixture: "express-qa.mjs",
    outputs: ["qa/result.json"],
  },
  {
    name: "fastapi",
    repository: "fastapi/fastapi",
    revision: "03002a00b48335fdd8159edb7920157b508d8c15",
    command: ["python", ".biodome/qa/check.py"],
    fixture: "fastapi-qa.py",
    outputs: ["qa/result.json"],
  },
];
const selected = process.argv[3]
  ? projects.filter((project) => process.argv[3].split(",").includes(project.name))
  : projects;
if (!existsSync(cli)) throw new Error("Run npm run build in Biodome first");
mkdirSync(root, { recursive: true });

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function prepare(project) {
  const directory = join(root, project.name);
  if (!existsSync(directory)) {
    git(root, [
      "clone",
      "--no-checkout",
      `https://github.com/${project.repository}.git`,
      directory,
    ]);
    git(directory, ["fetch", "--depth", "1", "origin", project.revision]);
    git(directory, ["checkout", "--detach", "FETCH_HEAD"]);
  }
  if (git(directory, ["rev-parse", "HEAD"]) !== project.revision)
    throw new Error(`Refusing a different revision in ${directory}`);
  const changedSource = git(directory, ["diff", "HEAD", "--name-only"])
    .split("\n")
    .filter((path) => path && path !== ".gitignore" && path !== ".dockerignore");
  if (changedSource.length > 0)
    throw new Error(`Refusing tracked source changes in ${directory}: ${changedSource.join(", ")}`);
  const config = join(directory, ".biodome");
  const marker = join(config, "public-qa-controller.json");
  if (existsSync(config) && !existsSync(marker))
    throw new Error(`Refusing to overwrite existing configuration in ${directory}`);
  for (const name of ["features", "targets", "actions", "qa"])
    mkdirSync(join(config, name), { recursive: true });
  writeFileSync(
    marker,
    JSON.stringify({ repository: project.repository, revision: project.revision }),
  );
  writeFileSync(
    join(config, "config.json"),
    JSON.stringify({ project: { name: `public-qa-${project.name}` } }),
  );
  copyFileSync(join(fixtures, `${project.name}.mjs`), join(config, "features/environment.mjs"));
  copyFileSync(
    join(fixtures, project.fixture),
    join(config, `qa/check.${project.name === "fastapi" ? "py" : "mjs"}`),
  );
  writeFileSync(
    join(config, "targets/local.mjs"),
    'export default ctx => ctx.useRuntime("docker-compose");\n',
  );
  for (const [name, timeout] of [
    ["qa", "2m"],
    ["timeout", "3s"],
  ]) {
    writeFileSync(
      join(config, `actions/${name}.mjs`),
      `export default ctx => ctx.addAction(${JSON.stringify({ command: project.command, intent: `Verify checked-out ${project.repository} functionality`, input: {}, outputs: project.outputs, cleanup: "always", timeout })});\n`,
    );
  }
  return directory;
}

async function runCase(project, directory, name, input, expectedExit) {
  const started = Date.now();
  const evidenceDir = join(root, "controller-evidence", `${project.name}-${name}-${started}`);
  mkdirSync(evidenceDir, { recursive: true });
  const journal = createWriteStream(join(evidenceDir, "stream.jsonl"));
  const stderr = createWriteStream(join(evidenceDir, "stderr.log"));
  const events = [];
  const parseErrors = [];
  let pending = "";
  let runId;
  let sawLiveReport = false;
  let sawPollingWhileRunning = false;
  let firstReportMs;
  let polling = false;
  let childExited = false;
  let cursor = 0;
  const polled = [];
  const decoder = new StringDecoder("utf8");
  const child = spawn(
    process.execPath,
    [
      cli,
      "run",
      "local",
      name === "timeout" ? "timeout" : "qa",
      "--stream",
      "--input",
      JSON.stringify(input),
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => {
    journal.write(chunk);
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        events.push(event);
        runId ??= event.runId;
        if (event.type === "action.report" && !childExited) {
          sawLiveReport = true;
          firstReportMs ??= Date.now() - started;
        }
      } catch {
        parseErrors.push(line.slice(0, 200));
      }
    }
  });
  child.stderr.on("data", (chunk) => stderr.write(chunk));
  const poll = async () => {
    if (!runId || polling || childExited) return;
    polling = true;
    try {
      const result = await new Promise((done) => {
        const query = spawn(
          process.execPath,
          [cli, "events", "--run", runId, "--after", String(cursor), "--limit", "1000", "--json"],
          { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
        );
        let text = "";
        query.stdout.on("data", (chunk) => {
          text += chunk;
        });
        query.on("error", () => done(undefined));
        query.on("close", (code) => {
          try {
            done(code === 0 ? JSON.parse(text) : undefined);
          } catch {
            done(undefined);
          }
        });
      });
      if (result) {
        cursor = result.nextSequence;
        polled.push(...result.events.map((event) => event.sequence));
        if (!childExited) sawPollingWhileRunning = true;
      }
    } finally {
      polling = false;
    }
  };
  const interval = setInterval(() => {
    void poll();
  }, 1500);
  const deadline = setTimeout(
    () => {
      child.kill("SIGTERM");
    },
    12 * 60 * 1000,
  );
  const exitCode = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      childExited = true;
      done(code);
    });
  });
  clearInterval(interval);
  clearTimeout(deadline);
  await new Promise((done) => journal.end(done));
  await new Promise((done) => stderr.end(done));
  const result = events.findLast((event) => event.type === "action.result")?.data;
  const recordPath = runId
    ? join(directory, ".biodome-build/targets/local/logs/runs", `${runId}.json`)
    : undefined;
  const record =
    recordPath && existsSync(recordPath) ? JSON.parse(readFileSync(recordPath)) : undefined;
  const artifacts = result?.artifacts ?? [];
  const filesExist =
    artifacts.length > 0 && artifacts.every((artifact) => existsSync(artifact.localPath));
  const reportFile = artifacts.find((artifact) => artifact.path === "qa/result.json");
  const report = reportFile ? JSON.parse(readFileSync(reportFile.localPath)) : undefined;
  const running = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `name=public-qa-${project.name}-local-`],
    { encoding: "utf8" },
  );
  const clean = running.status === 0 && running.stdout.trim() === "";
  const state = join(directory, ".biodome-build/targets/local/state.json");
  if (existsSync(state))
    spawnSync(process.execPath, [cli, "down", "local"], {
      cwd: directory,
      stdio: "ignore",
      timeout: 60000,
    });
  const actualFailure = exitCode !== 0;
  const expectedFailure = expectedExit !== 0;
  const scenarioMatched =
    name === "persistence-probe"
      ? result?.exitCode === 7 &&
        report?.checks?.some(
          (check) =>
            check.name === "Persistence probe: todo survives reload" && check.status === "failed",
        )
      : name === "negative-control"
        ? result?.exitCode === 7 &&
          report?.checks?.some(
            (check) =>
              check.name.startsWith("Intentional negative control") && check.status === "failed",
          )
        : name === "timeout"
          ? result?.exitCode === 124 && record?.outcome === "timed-out"
          : result?.exitCode === 0 && report?.status === "passed";
  const valid =
    actualFailure === expectedFailure &&
    result &&
    filesExist &&
    clean &&
    parseErrors.length === 0 &&
    scenarioMatched &&
    sawLiveReport;
  const summary = {
    repository: project.repository,
    revision: project.revision,
    case: name,
    valid: Boolean(valid),
    cliExitCode: exitCode,
    actionExitCode: result?.exitCode,
    reportStatus: report?.status,
    checks: report?.checks,
    elapsedMs: Date.now() - started,
    runId,
    source: record?.source,
    eventCount: events.length,
    eventTypes: [...new Set(events.map((event) => event.type))],
    liveReportsBeforeExit: sawLiveReport,
    pollingWhileRunning: sawPollingWhileRunning,
    firstReportMs,
    cursorEventsRead: polled.length,
    parseErrors,
    artifacts,
    evidenceDir,
    cleanupSucceeded: clean,
    finalRunStatus: record?.status,
    outcome: record?.outcome,
    startupError: result
      ? undefined
      : events.findLast((event) => event.type === "run.failed")?.data,
  };
  writeFileSync(join(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  return summary;
}

const summaries = [];
for (const project of selected) {
  const directory = prepare(project);
  summaries.push(await runCase(project, directory, "positive", { pauseSeconds: 6 }, 0));
  if (project.name === "todomvc") {
    summaries.push(
      await runCase(project, directory, "persistence-probe", { requirePersistence: true }, 1),
    );
  }
  summaries.push(
    await runCase(
      project,
      directory,
      "negative-control",
      { forceFailure: true, pauseSeconds: 0 },
      1,
    ),
  );
  if (project.name === "express")
    summaries.push(await runCase(project, directory, "timeout", { pauseSeconds: 30 }, 1));
}
writeFileSync(join(root, "results.json"), JSON.stringify(summaries, null, 2));
process.exitCode = summaries.every((summary) => summary.valid) ? 0 : 1;
