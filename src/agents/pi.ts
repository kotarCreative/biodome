import { createHomeLayoutAdapter, type AgentAdapter } from "./adapter.js";
import type { PiHarness } from "../core/plan.js";

export const piAdapter: AgentAdapter<PiHarness> = createHomeLayoutAdapter({
  id: "pi",
  displayName: "Pi",
  harnessType: "pi",
  homesKey: "piHomes",
});
