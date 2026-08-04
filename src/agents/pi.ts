import type { AgentAdapter } from "./adapter.js";
import type { PiHarness } from "../core/plan.js";

export const piAdapter: AgentAdapter<PiHarness> = {
  id: "pi",
  displayName: "Pi",
  harnessType: "pi",
  command: ({ harness, prompt, layout }) => [`${layout.piHomes}/${harness.name}/task`, prompt],
};
