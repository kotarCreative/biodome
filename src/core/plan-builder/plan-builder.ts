import type { ApplicationPlanAccess } from "../../apps/application-builder.js";
import { runtimeLayout } from "../../runtime/layout.js";
import { createFeatureContext } from "../context.js";
import type { FeatureContext } from "../feature.js";
import { createPlan, type Plan } from "../plan.js";
import { BuildBuilder } from "./build.js";
import { EnvironmentBuilder } from "./environment.js";
import { HarnessBuilder } from "./harnesses.js";
import { McpBuilder, type McpOptions } from "./mcp.js";
import { ProcessBuilder } from "./processes.js";
import { createNodeProjectIO, type ProjectIO } from "./project-io.js";
import { ProviderBuilder } from "./providers.js";
import { RepositoryBuilder } from "./repositories.js";
import { ServiceBuilder } from "./services.js";
import { VolumeBuilder } from "./volumes.js";

export class PlanBuilder {
  private readonly plan: Plan;
  private readonly build: BuildBuilder;
  private readonly environment: EnvironmentBuilder;
  private readonly processes: ProcessBuilder;
  private readonly services: ServiceBuilder;
  private readonly repositories: RepositoryBuilder;
  private readonly volumes: VolumeBuilder;
  private readonly providers: ProviderBuilder;
  private readonly harnesses: HarnessBuilder;
  private readonly mcp: McpBuilder;
  private readonly rootDir: string;
  private readonly dryRun: boolean;
  private readonly io: ProjectIO;
  private finalized = false;

  readonly context: FeatureContext;
  readonly applications: ApplicationPlanAccess;

  constructor(
    rootDir: string,
    project: string,
    dryRun = false,
    io: ProjectIO = createNodeProjectIO(rootDir),
  ) {
    this.rootDir = rootDir;
    this.dryRun = dryRun;
    this.io = io;
    this.plan = createPlan(project);

    const layout = runtimeLayout("").container;
    this.build = new BuildBuilder(this.plan, (path) => this.io.fileExists(path));
    this.environment = new EnvironmentBuilder(this.plan);
    this.processes = new ProcessBuilder(this.plan, (name) => this.build.addAptPackage(name));
    this.services = new ServiceBuilder(this.plan);

    const addProcess: FeatureContext["addProcess"] = (spec) =>
      this.mutate(() => this.processes.addProcess(spec));
    const addHook: FeatureContext["addHook"] = (spec) =>
      this.mutate(() => this.processes.addHook(spec));
    const addLanguage: FeatureContext["addLanguage"] = (name, options) =>
      this.mutate(() => this.build.addLanguage(name, options));
    const addEnv: FeatureContext["addEnv"] = (key, spec) =>
      this.mutate(() => this.environment.add(key, spec));

    this.repositories = new RepositoryBuilder(
      this.plan,
      (name) => this.build.addAptPackage(name),
      addHook,
      layout.repositories,
    );
    this.volumes = new VolumeBuilder(
      this.plan,
      (name) => this.build.addAptPackage(name),
      addProcess,
    );
    this.providers = new ProviderBuilder(this.plan, addEnv);
    this.harnesses = new HarnessBuilder(this.plan, layout, {
      addLanguage,
      addAptPackage: (name) => this.build.addAptPackage(name),
      addLanguageSnippet: (snippet) => this.build.addLanguageSnippet(snippet),
      addProcess,
      addEnv,
    });
    this.mcp = new McpBuilder(this.plan, layout, {
      addLanguage,
      addProcess,
      volumeCredentialEnvironment: () => this.volumes.mcpCredentialEnvironment(),
      providerCredentialEnvironment: () => this.providers.mcpCredentialEnvironment(),
    });

    this.context = createFeatureContext({
      addProcess,
      addHook,
      addLanguage,
      addPackage: (manager, name, options) =>
        this.mutate(() => this.build.addPackage(manager, name, options)),
      addTool: (name, options) => this.mutate(() => this.build.addTool(name, options)),
      addService: (name, options) => this.mutate(() => this.services.add(name, options)),
      addEndpoint: (spec) => this.mutate(() => this.providers.addEndpoint(spec)),
      addProvider: (spec) => this.mutate(() => this.providers.addProvider(spec)),
      addMcpProvider: (spec) => this.mutate(() => this.providers.addMcpProvider(spec)),
      addJiraProvider: (spec) => this.mutate(() => this.providers.addJiraProvider(spec)),
      addLinearProvider: (spec) => this.mutate(() => this.providers.addLinearProvider(spec)),
      addSentryProvider: (spec) => this.mutate(() => this.providers.addSentryProvider(spec)),
      addSlackProvider: (spec) => this.mutate(() => this.providers.addSlackProvider(spec)),
      addGithubProvider: (spec) => this.mutate(() => this.providers.addGithubProvider(spec)),
      addEnv,
      addVolume: (spec) => this.mutate(() => this.volumes.add(spec)),
      addRepo: (spec) => this.mutate(() => this.repositories.add(spec)),
      addOpencodeHarness: (spec) => this.mutate(() => this.harnesses.addOpencodeHarness(spec)),
      addPiHarness: (spec) => this.mutate(() => this.harnesses.addPiHarness(spec)),
      addCodexHarness: (spec) => this.mutate(() => this.harnesses.addCodexHarness(spec)),
      addClaudeHarness: (spec) => this.mutate(() => this.harnesses.addClaudeHarness(spec)),
      addLlmProvider: (spec) => this.mutate(() => this.providers.addLlmProvider(spec)),
      addLocalVolume: (spec) => this.mutate(() => this.volumes.addLocal(spec)),
      addS3Volume: (spec) => this.mutate(() => this.volumes.addS3(spec)),
      addGcsVolume: (spec) => this.mutate(() => this.volumes.addGcs(spec)),
      addAzureVolume: (spec) => this.mutate(() => this.volumes.addAzure(spec)),
      addSftpVolume: (spec) => this.mutate(() => this.volumes.addSftp(spec)),
      addSmbVolume: (spec) => this.mutate(() => this.volumes.addSmb(spec)),
      addWebdavVolume: (spec) => this.mutate(() => this.volumes.addWebdav(spec)),
      addDropboxVolume: (spec) => this.mutate(() => this.volumes.addDropbox(spec)),
      addGdriveVolume: (spec) => this.mutate(() => this.volumes.addGdrive(spec)),
      fileExists: (path) => this.io.fileExists(path),
      readFile: (path) => this.io.readFile(path),
      readJSON: (path) => this.io.readJSON(path),
      exec: dryRun
        ? () => ({ stdout: "", stderr: "", exitCode: 0 })
        : (command) => {
            console.log(`[exec] ${command}`);
            return this.io.exec(command);
          },
    });
    this.applications = this.createApplicationPlanAccess();
  }

  finalize(): void {
    this.assertCollecting();
    this.build.finalize();
    this.finalized = true;
  }

  configureMcp(port: number, options: McpOptions = {}): void {
    this.mutate(() => this.mcp.configure(port, options));
  }

  getPlan(): Plan {
    if (!this.finalized) throw new Error("Plan is not available before finalization");
    return this.plan;
  }

  async expandApplications(
    expand: (context: FeatureContext, plan: ApplicationPlanAccess) => Promise<void>,
  ): Promise<void> {
    this.assertCollecting();
    const expansion = new PlanBuilder(this.rootDir, this.plan.project, this.dryRun, this.io);
    Object.assign(expansion.plan, structuredClone(this.plan));
    await expand(expansion.context, expansion.applications);
    Object.assign(this.plan, expansion.plan);
  }

  private createApplicationPlanAccess(): ApplicationPlanAccess {
    return {
      serviceEnvironment: (name) => {
        const service = this.plan.runtime.services.find((entry) => entry.name === name);
        return service ? { ...service.environment } : undefined;
      },
      processPort: (name) => {
        const process = this.plan.runtime.processes.find((entry) => entry.name === name);
        return process ? (process.ports[0]?.container ?? null) : undefined;
      },
      hasEndpoint: (name) => this.plan.runtime.endpoints.some((entry) => entry.name === name),
      recordApplication: (application) => {
        this.mutate(() => this.plan.runtime.applications.push(application));
      },
      recordContribution: (contribution) => {
        this.mutate(() => this.plan.runtime.contributions.push(contribution));
      },
      sortApplications: () => {
        this.mutate(() =>
          this.plan.runtime.applications.sort((a, b) => a.name.localeCompare(b.name)),
        );
      },
      sortContributions: () => {
        this.mutate(() =>
          this.plan.runtime.contributions.sort((a, b) =>
            a.qualifiedName.localeCompare(b.qualifiedName),
          ),
        );
      },
    };
  }

  private mutate<T>(operation: () => T): T {
    this.assertCollecting();
    return operation();
  }

  private assertCollecting(): void {
    if (this.finalized) throw new Error("PlanBuilder is already finalized");
  }
}
