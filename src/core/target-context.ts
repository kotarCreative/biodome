import {
  type RuntimeDriverId,
  type RuntimeTarget,
  validateTargetName,
  validateJsonSafeOptions,
} from "./plan.js";
import type { TargetContext } from "./feature.js";
import { ValidationError } from "./errors.js";

export class TargetContextImpl implements TargetContext {
  private targetName: string;
  private declared: RuntimeTarget | null = null;

  constructor(targetName: string) {
    this.targetName = targetName;
  }

  useRuntime(driver: RuntimeDriverId, options: Record<string, unknown> = {}): void {
    if (this.declared !== null) {
      throw new ValidationError({
        message: `Target "${this.targetName}" called useRuntime twice (${this.declared.driver} and ${driver}). A target may declare only one runtime.`,
      });
    }

    try {
      validateTargetName(this.targetName);
    } catch (e) {
      throw new ValidationError({ message: (e as Error).message });
    }

    if (!driver || typeof driver !== "string") {
      throw new ValidationError({
        message: `Target "${this.targetName}": runtime driver must be a non-empty string`,
      });
    }

    try {
      validateJsonSafeOptions(options, `Target "${this.targetName}" options`);
    } catch (e) {
      throw new ValidationError({ message: (e as Error).message });
    }

    this.declared = {
      name: this.targetName,
      driver,
      options,
    };
  }

  getTarget(): RuntimeTarget {
    if (this.declared === null) {
      throw new ValidationError({
        message: `Target "${this.targetName}" did not declare a runtime. Call useRuntime() in the target module.`,
      });
    }
    return this.declared;
  }
}
