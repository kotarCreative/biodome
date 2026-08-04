import type { AgentAdapter } from "./adapter.js";
import type { AgentHarness } from "../core/plan.js";

export const opencodeAdapter: AgentAdapter<AgentHarness> = {
  id: "opencode",
  displayName: "OpenCode",
  harnessType: "opencode",
  command: ({ harness, prompt, layout }) => [
    `${layout.opencodeHomes}/${harness.name}/task`,
    prompt,
  ],
};
