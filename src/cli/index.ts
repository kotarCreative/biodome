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

function runHooks(plan: any, point: string): void {
  const hooks = plan.runtime.processes.filter((p: any) => p.mode === "oneshot" && p.startOn === point);
  if (hooks.length === 0) return;

  const runner = new Runner(plan.project);
  for (const hook of hooks) {
    console.log(`[hook] ${hook.name} (${point})`);
    runner.execInDev(hook.command);
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
    writeFileSync(join(sandboxDir, "features"), ""); // placeholder
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
    runner.build(rootDir);
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

    if (options.build) {
      const runner = new Runner(plan.project);
      runner.build(rootDir);
    }

    const runner = new Runner(plan.project);
    // Start services here if plan.runtime.services.length > 0
    // For now, services are handled via docker-compose manually.
    runner.startDev(plan, rootDir);
    runHooks(plan, "start.post");

    console.log(`Workspace ${plan.project} is running`);

    if (options.wait) {
      console.log("Press Ctrl+C to stop");
      process.on("SIGINT", () => {
        console.log("\nStopping...");
        runner.stopDev();
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
    runHooks(plan, "stop.pre");
    const runner = new Runner(plan.project);
    runner.stopDev();
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
    runHooks(plan, "exec.pre");
    runner.execInDev(cmd);
    runHooks(plan, "exec.post");
  });

program.parse();
