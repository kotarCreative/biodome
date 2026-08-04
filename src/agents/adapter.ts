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
