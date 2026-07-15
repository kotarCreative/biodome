import { execSync } from "node:child_process";
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan } from "../builder/index.js";
import { generateDockerfile, generateSupervisordConf, generateCompose, generateDockerignore } from "../docker/generator.js";
import { Runner } from "../docker/runner.js";

const SANDBOX_DIR = ".sandbox";

function ensureSandboxDir(rootDir: string): void {
  mkdirSync(join(rootDir, SANDBOX_DIR), { recursive: true });
}

function writeGeneratedFiles(rootDir: string, plan: any): void {
  ensureSandboxDir(rootDir);
  writeFileSync(join(rootDir, SANDBOX_DIR, "Dockerfile"), generateDockerfile(plan));

  const supervisord = generateSupervisordConf(plan);
  if (supervisord) {
    writeFileSync(join(rootDir, SANDBOX_DIR, "supervisord.conf"), supervisord);
  }

  writeFileSync(join(rootDir, SANDBOX_DIR, "docker-compose.yaml"), generateCompose(plan));
  writeFileSync(join(rootDir, ".dockerignore"), generateDockerignore());
}

function runHooks(plan: any, point: string, runner: Runner, rootDir: string): void {
  const hooks = plan.runtime.processes.filter((p: any) => p.mode === "oneshot" && p.startOn === point);
  if (hooks.length === 0) return;

  const hostPoints = new Set(["build.pre", "build.post", "start.pre", "stop.post"]);

  for (const hook of hooks) {
    console.log(`[hook] ${hook.name} (${point})`);
    if (hostPoints.has(point)) {
      const [cmd, ...args] = hook.command;
      execSync(`${cmd} ${args.join(" ")}`, { stdio: "inherit", cwd: rootDir });
    } else {
      runner.execInDev(hook.command);
    }
  }
}

const program = new Command();
program.name("sandbox").description("Development environment manager").version("0.1.0");

program
  .command("init")
  .description("Initialize a sandbox/ directory")
  .action(() => {
    const rootDir = process.cwd();
    const sandboxDir = join(rootDir, "sandbox");
    if (existsSync(sandboxDir)) {
      console.error("Sandbox directory already exists");
      process.exit(1);
    }
    mkdirSync(sandboxDir, { recursive: true });
    const projectName = rootDir.split("/").pop() || "project";
    writeFileSync(
      join(sandboxDir, "config.json"),
      JSON.stringify({ project: { name: projectName } }, null, 2) + "\n"
    );
    writeFileSync(join(sandboxDir, "services.js"), "// Define backing services here\n");
    mkdirSync(join(sandboxDir, "features"), { recursive: true });
    writeFileSync(join(sandboxDir, "features", ".gitkeep"), "");
    console.log(`Initialized sandbox for ${projectName}`);
  });

program
  .command("build")
  .description("Prepare the development environment")
  .action(() => {
    const rootDir = process.cwd();
    const plan = buildPlan(rootDir);
    writeGeneratedFiles(rootDir, plan);
    const runner = new Runner(plan.project);
    runHooks(plan, "build.pre", runner, rootDir);
    runner.build(rootDir);
    runHooks(plan, "build.post", runner, rootDir);
    console.log(`Environment ready for ${plan.project}`);
  });

program
  .command("up")
  .description("Start the development environment")
  .option("--build", "Rebuild the environment before starting")
  .option("--wait", "Block until Ctrl+C is pressed")
  .action((options) => {
    const rootDir = process.cwd();
    const plan = buildPlan(rootDir);
    writeGeneratedFiles(rootDir, plan);

    const runner = new Runner(plan.project);
    runHooks(plan, "start.pre", runner, rootDir);
    runner.up(rootDir, options.build);
    runHooks(plan, "start.post", runner, rootDir);

    console.log(`Workspace ${plan.project} is running`);

    if (options.wait) {
      console.log("Press Ctrl+C to stop");
      process.on("SIGINT", () => {
        console.log("\nStopping...");
        runner.down(rootDir);
        process.exit(0);
      });
      // Keep alive
      setInterval(() => {}, 1000);
    }
  });

program
  .command("down")
  .description("Stop the development environment")
  .action(() => {
    const rootDir = process.cwd();
    const plan = buildPlan(rootDir);
    const runner = new Runner(plan.project);
    runHooks(plan, "stop.pre", runner, rootDir);
    runner.down(rootDir);
    runHooks(plan, "stop.post", runner, rootDir);
    console.log("Stopped");
  });

program
  .command("exec <command...>")
  .description("Run a command in the dev container")
  .allowUnknownOption()
  .action((cmd: string[]) => {
    const rootDir = process.cwd();
    const plan = buildPlan(rootDir);
    const runner = new Runner(plan.project);
    runHooks(plan, "exec.pre", runner, rootDir);
    runner.execInDev(cmd);
    runHooks(plan, "exec.post", runner, rootDir);
  });

program.parse();
