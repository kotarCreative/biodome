import type { Plan } from "../core/plan.js";
import { ValidationError } from "../core/errors.js";
import { runtimeLayout } from "../runtime/layout.js";
import type { AgentAdapter, ConfiguredAgent } from "./adapter.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";

export const builtInAgentAdapters: readonly AgentAdapter[] = [
  piAdapter,
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
];

export interface ResolvedAgent {
  adapter: AgentAdapter;
  harness: ConfiguredAgent;
}

/** Resolves a named configured harness to its portable agent adapter. */
export function resolveAgent(plan: Plan, harnessName: string): ResolvedAgent {
  // Keep this order aligned with the pre-adapter task command resolution.
  const candidates: readonly ConfiguredAgent[] = [
    ...plan.runtime.piHarnesses,
    ...plan.runtime.claudeHarnesses,
    ...plan.runtime.codexHarnesses,
    ...plan.runtime.agentHarnesses,
  ];
  const harness = candidates.find((candidate) => candidate.name === harnessName);
  if (!harness) {
    throw new ValidationError({ message: `Harness "${harnessName}" not found in plan` });
  }

  const adapter = builtInAgentAdapters.find((candidate) => candidate.harnessType === harness.type);
  if (!adapter) {
    throw new ValidationError({
      message: `No agent adapter is registered for harness "${harnessName}" (type "${harness.type}")`,
    });
  }

  return { adapter, harness };
}

/** Builds the command used to execute a configured agent task in a workspace. */
export function agentTaskCommand(plan: Plan, harnessName: string, prompt: string): string[] {
  const { adapter, harness } = resolveAgent(plan, harnessName);
  const targetName = plan.deployment?.target.name;
  if (!targetName) {
    throw new ValidationError({
      message: `Cannot build task command for harness "${harnessName}": plan has no deployment target`,
    });
  }
  const layout = runtimeLayout("", targetName);
  return adapter.command({ harness, prompt, layout: layout.container });
}
