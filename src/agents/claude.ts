import type { AgentAdapter } from "./adapter.js";
import type { ClaudeHarness } from "../core/plan.js";

export const claudeAdapter: AgentAdapter<ClaudeHarness> = {
  id: "claude",
  displayName: "Claude Code",
  harnessType: "claude",
  command: ({ harness, prompt, layout }) => [`${layout.claudeHomes}/${harness.name}/task`, prompt],
};
