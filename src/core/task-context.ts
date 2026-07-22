import { type Task, type TaskSpec, parseDuration, validateArtifactPath } from "./plan.js";
import type { TaskContext } from "./feature.js";
import { ValidationError } from "./errors.js";

export class TaskContextImpl implements TaskContext {
  private taskName: string;
  private declared: TaskSpec | null = null;

  constructor(taskName: string) {
    this.taskName = taskName;
  }

  addTask(spec: TaskSpec): void {
    if (this.declared !== null) {
      throw new ValidationError({
        message: `Task "${this.taskName}" called addTask twice. A task module may declare only one task.`,
      });
    }

    if (!spec.harness || typeof spec.harness !== "string") {
      throw new ValidationError({ message: `Task "${this.taskName}": harness is required` });
    }

    if (!spec.prompt || typeof spec.prompt !== "string") {
      throw new ValidationError({ message: `Task "${this.taskName}": prompt is required` });
    }

    const artifacts = spec.artifacts ?? [];
    for (const artifact of artifacts) {
      try {
        validateArtifactPath(artifact);
      } catch (e) {
        throw new ValidationError({
          message: `Task "${this.taskName}": invalid artifact path "${artifact}": ${(e as Error).message}`,
        });
      }
    }

    const timeout = spec.timeout ?? "20m";
    try {
      parseDuration(timeout);
    } catch (e) {
      throw new ValidationError({
        message: `Task "${this.taskName}": invalid timeout "${timeout}": ${(e as Error).message}`,
      });
    }

    const cleanup = spec.cleanup ?? "never";

    this.declared = {
      harness: spec.harness,
      prompt: spec.prompt,
      artifacts,
      timeout,
      cleanup,
    };
  }

  getTask(): Task {
    if (this.declared === null) {
      throw new ValidationError({
        message: `Task "${this.taskName}" did not declare a task. Call addTask() in the task module.`,
      });
    }
    return {
      name: this.taskName,
      ...this.declared,
    };
  }
}
