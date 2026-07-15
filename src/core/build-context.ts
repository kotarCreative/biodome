import { Plan } from "./plan.js";

export interface BuildContext {
  plan: Plan;
  addAptPackage(name: string): void;
  addLanguageSnippet(snippet: string): void;
}
