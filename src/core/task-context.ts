import { Schema } from "effect";
import { type Task, type TaskSpec, TaskSpecSchema, validateArtifactPath } from "./plan.js";
import type { TaskContext } from "./feature.js";
import { ValidationError } from "./errors.js";

function validateJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach(validateJson);
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach(validateJson);
    return;
  }
  throw new Error("input must contain only JSON values");
}

export class TaskContextImpl implements TaskContext {
  private declared: Task | null = null;

  constructor(private readonly taskName: string) {}

  addAction(spec: TaskSpec): void {
    if (this.declared !== null) {
      throw new ValidationError({ message: `Action "${this.taskName}" called addAction twice` });
    }
    try {
      Schema.decodeUnknownSync(TaskSpecSchema)(spec);
      if (!spec.intent.trim()) throw new Error("intent must not be blank");
      if (spec.intent.includes("\0") || Buffer.byteLength(spec.intent) > 16384) {
        throw new Error("intent must not contain NUL bytes or exceed 16 KiB");
      }
      for (const command of [spec.command, ...(spec.validationCommands ?? [])]) {
        if (!command[0]?.trim()) throw new Error("command must name an executable");
        if (command.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
          throw new Error("command arguments must be strings and must not contain NUL bytes");
        }
      }
      // Bound serialized input before recursing: cyclic values fail here too.
      const input = spec.input ?? {};
      const json = JSON.stringify(input);
      if (json === undefined || Buffer.byteLength(json) > 65536) {
        throw new Error("input must be a JSON object of at most 64 KiB");
      }
      validateJson(input);
      const artifacts = spec.outputs ?? [];
      artifacts.forEach(validateArtifactPath);
      this.declared = {
        name: this.taskName,
        command: [...spec.command],
        intent: spec.intent,
        input: structuredClone(input),
        artifacts: [...artifacts],
        timeout: spec.timeout ?? "20m",
        cleanup: spec.cleanup ?? "never",
        requiredServices: spec.requiredServices,
        requiredProcesses: spec.requiredProcesses,
        capabilities: spec.capabilities,
        resources: spec.resources,
        network: spec.network,
        workspace: spec.workspace,
        validationCommands: spec.validationCommands,
      };
    } catch (error) {
      throw new ValidationError({ message: `Action "${this.taskName}": ${String(error)}` });
    }
  }

  getTask(): Task {
    if (!this.declared) {
      throw new ValidationError({
        message: `Action "${this.taskName}" did not declare an action. Call addAction().`,
      });
    }
    return structuredClone(this.declared);
  }
}
