import { execFileSync } from "node:child_process";
import { validateConfig } from "../builder/index.js";
import { Plan } from "../core/plan.js";
import { Provider } from "../core/provider.js";

const HOST_HOOK_POINTS = new Set([
  "build.pre",
  "build.post",
  "start.pre",
  "stop.post",
]);

export function resolveProjectName(rootDir: string): string {
  return validateConfig(rootDir).project.name;
}

export function runSafe(fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}

export function runHooks(
  plan: Plan,
  point: string,
  runner: Provider,
  rootDir: string
): void {
  const hooks = plan.runtime.processes.filter(
    (p) => p.mode === "oneshot" && p.startOn === point
  );
  if (hooks.length === 0) return;

  for (const hook of hooks) {
    console.log(`[hook] ${hook.name} (${point})`);
    if (HOST_HOOK_POINTS.has(point)) {
      const [cmd, ...args] = hook.command;
      execFileSync(cmd, args, { stdio: "inherit", cwd: rootDir });
    } else {
      runner.execInDev(hook.command);
    }
  }
}
