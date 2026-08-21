import { createHomeLayoutAdapter, type AgentAdapter } from "./adapter.js";
import type { ClaudeHarness } from "../core/plan.js";

export const claudeAdapter: AgentAdapter<ClaudeHarness> = createHomeLayoutAdapter({
  id: "claude",
  displayName: "Claude Code",
  harnessType: "claude",
  homesKey: "claudeHomes",
});
