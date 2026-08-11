import type { FeatureContext } from "../feature.js";
import type { Plan } from "../plan.js";
import { SandboxContext } from "../context.js";
import type { McpOptions } from "./mcp.js";
import { createNodeProjectIO, type ProjectIO } from "./project-io.js";

export class PlanBuilder {
  private readonly contextImpl: SandboxContext;
  readonly context: FeatureContext;

  constructor(
    rootDir: string,
    project: string,
    dryRun = false,
    io: ProjectIO = createNodeProjectIO(rootDir),
  ) {
    this.contextImpl = new SandboxContext(rootDir, project, dryRun, io);
    this.context = this.contextImpl;
  }

  finalize(): void {
    this.contextImpl.finalizeBuildPlan();
  }

  configureMcp(port: number, options: McpOptions = {}): void {
    this.contextImpl.configureMcp(port, options);
  }

  getPlan(): Plan {
    return this.contextImpl.plan;
  }

  /** Internal bridge for app recipes; keeps all primitive mutation in SandboxContext. */
  get mutableContext(): SandboxContext {
    return this.contextImpl;
  }
}
