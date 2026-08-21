import { createHomeLayoutAdapter, type AgentAdapter } from "./adapter.js";
import type { CodexHarness } from "../core/plan.js";

export const codexAdapter: AgentAdapter<CodexHarness> = createHomeLayoutAdapter({
  id: "codex",
  displayName: "Codex",
  harnessType: "codex",
  homesKey: "codexHomes",
});
