import type { AgentAdapter } from "./adapter.js";
import type { CodexHarness } from "../core/plan.js";

export const codexAdapter: AgentAdapter<CodexHarness> = {
  id: "codex",
  displayName: "Codex",
  harnessType: "codex",
  command: ({ harness, prompt, layout }) => [`${layout.codexHomes}/${harness.name}/task`, prompt],
};
