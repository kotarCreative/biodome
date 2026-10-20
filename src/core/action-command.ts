import type { Task } from "./plan.js";

/** Keep caller-supplied metadata as argv data, not interpolated shell source. */
export function actionCommand(task: Task): string[] {
  return [
    "env",
    `BIODOME_ACTION_NAME=${task.name}`,
    `BIODOME_ACTION_INTENT=${task.intent}`,
    `BIODOME_ACTION_INPUT=${JSON.stringify(task.input)}`,
    `BIODOME_ACTION_OUTPUTS=${JSON.stringify(task.artifacts)}`,
    ...task.command,
  ];
}
