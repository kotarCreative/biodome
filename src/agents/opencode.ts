import { createHomeLayoutAdapter, type AgentAdapter } from "./adapter.js";
import type { AgentHarness } from "../core/plan.js";

export const opencodeAdapter: AgentAdapter<AgentHarness> = createHomeLayoutAdapter({
  id: "opencode",
  displayName: "OpenCode",
  harnessType: "opencode",
  homesKey: "opencodeHomes",
});
