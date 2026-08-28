import { ValidationError } from "../core/errors.js";
import { validateTargetName } from "../core/plan.js";

function validateName(name: string, label: string): void {
  try {
    validateTargetName(name);
  } catch (error) {
    throw new ValidationError({
      message: `Invalid ${label} name "${name}": ${(error as Error).message}`,
    });
  }
}

/** Qualifies an app-local primitive without ambiguous separator parsing. */
export function qualifyAppPrimitive(application: string, localName: string): string {
  validateName(application, "application");
  validateName(localName, `local declaration for application "${application}"`);
  return `app-${application.length}-${application}-${localName}`;
}
