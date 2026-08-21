import type { AgentHarness, ClaudeHarness, CodexHarness, PiHarness } from "../core/plan.js";
import type { RuntimeLayout } from "../runtime/layout.js";

/** A configured harness supported by Biodome's agent execution layer. */
export type ConfiguredAgent = AgentHarness | PiHarness | CodexHarness | ClaudeHarness;

/**
 * The portable command request passed from orchestration to an agent adapter.
 *
 * Providers own how a command is executed; adapters only describe the command
 * that invokes a configured harness inside an already-prepared workspace.
 */
export interface AgentCommandInput<THarness extends ConfiguredAgent = ConfiguredAgent> {
  harness: THarness;
  prompt: string;
  layout: RuntimeLayout["container"];
}

/**
 * Maps one agent harness type to its in-environment task command.
 *
 * This deliberately has no runtime-driver dependency. The same adapter can be
 * used by Compose, Docker Sandboxes, ECS, or a future provider.
 */
export interface AgentAdapter<THarness extends ConfiguredAgent = ConfiguredAgent> {
  readonly id: string;
  readonly displayName: string;
  readonly harnessType: THarness["type"];
  command(input: AgentCommandInput<THarness>): string[];
}

/** The container-layout keys that hold a harness family's per-harness homes. */
export type HomeLayoutKey = "opencodeHomes" | "piHomes" | "codexHomes" | "claudeHomes";

/** Declaration for a harness family whose task command runs from its layout home. */
export interface HomeLayoutAdapterConfig<THarness extends ConfiguredAgent> {
  readonly id: string;
  readonly displayName: string;
  readonly harnessType: THarness["type"];
  readonly homesKey: HomeLayoutKey;
}

/**
 * Builds the adapter for a harness family following the shared on-disk
 * convention: one home directory per configured harness under the family's
 * layout key, with tasks executed from `<homes>/<harness>/task`.
 */
export function createHomeLayoutAdapter<THarness extends ConfiguredAgent>(
  config: HomeLayoutAdapterConfig<THarness>,
): AgentAdapter<THarness> {
  return {
    id: config.id,
    displayName: config.displayName,
    harnessType: config.harnessType,
    command: ({ harness, prompt, layout }) => [
      `${layout[config.homesKey]}/${harness.name}/task`,
      prompt,
    ],
  };
}
