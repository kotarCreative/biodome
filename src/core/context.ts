import { createPlan, Plan } from "./plan.js";
import {
  FeatureContext,
  ProcessSpec,
  HookSpec,
  LanguageOptions,
  PackageOptions,
  ToolOptions,
  ServiceOptions,
  EnvSpec,
  VolumeSpec,
  LocalVolumeSpec,
  S3VolumeSpec,
  GcsVolumeSpec,
  AzureVolumeSpec,
  SftpVolumeSpec,
  SmbVolumeSpec,
  WebdavVolumeSpec,
  DropboxVolumeSpec,
  GdriveVolumeSpec,
  RepoSpec,
} from "./feature.js";
import { runtimeLayout } from "../runtime/layout.js";
import { createNodeProjectIO, type ProjectIO } from "./plan-builder/project-io.js";
import { EnvironmentBuilder } from "./plan-builder/environment.js";
import { ProcessBuilder } from "./plan-builder/processes.js";
import { ServiceBuilder } from "./plan-builder/services.js";
import { RepositoryBuilder } from "./plan-builder/repositories.js";
import { VolumeBuilder } from "./plan-builder/volumes.js";
import { ProviderBuilder } from "./plan-builder/providers.js";
import { HarnessBuilder } from "./plan-builder/harnesses.js";
import { BuildBuilder } from "./plan-builder/build.js";
import { McpBuilder, type McpOptions } from "./plan-builder/mcp.js";

export class SandboxContext implements FeatureContext {
  plan: Plan;
  private readonly layout = runtimeLayout("");
  private dryRun: boolean;
  private io: ProjectIO;
  private build: BuildBuilder;
  private environment: EnvironmentBuilder;
  private processes: ProcessBuilder;
  private services: ServiceBuilder;
  private repositories: RepositoryBuilder;
  private volumes: VolumeBuilder;
  private providers: ProviderBuilder;
  private harnesses: HarnessBuilder;
  private mcp: McpBuilder;
  readonly addEndpoint: FeatureContext["addEndpoint"];
  readonly addProvider: FeatureContext["addProvider"];
  readonly addMcpProvider: FeatureContext["addMcpProvider"];
  readonly addJiraProvider: FeatureContext["addJiraProvider"];
  readonly addLinearProvider: FeatureContext["addLinearProvider"];
  readonly addSentryProvider: FeatureContext["addSentryProvider"];
  readonly addSlackProvider: FeatureContext["addSlackProvider"];
  readonly addGithubProvider: FeatureContext["addGithubProvider"];
  readonly addLlmProvider: FeatureContext["addLlmProvider"];
  readonly addOpencodeHarness: FeatureContext["addOpencodeHarness"];
  readonly addPiHarness: FeatureContext["addPiHarness"];
  readonly addCodexHarness: FeatureContext["addCodexHarness"];
  readonly addClaudeHarness: FeatureContext["addClaudeHarness"];

  constructor(
    rootDir: string,
    project: string,
    dryRun = false,
    io: ProjectIO = createNodeProjectIO(rootDir),
  ) {
    this.dryRun = dryRun;
    this.io = io;
    this.plan = createPlan(project);
    this.build = new BuildBuilder(this.plan, (path) => this.io.fileExists(path));
    this.environment = new EnvironmentBuilder(this.plan);
    this.processes = new ProcessBuilder(this.plan, (name) => this.build.addAptPackage(name));
    this.services = new ServiceBuilder(this.plan);
    this.repositories = new RepositoryBuilder(
      this.plan,
      (name) => this.build.addAptPackage(name),
      (spec) => this.addHook(spec),
      this.layout.container.repositories,
    );
    this.volumes = new VolumeBuilder(
      this.plan,
      (name) => this.build.addAptPackage(name),
      (spec) => this.addProcess(spec),
    );
    this.providers = new ProviderBuilder(this.plan, (key, spec) => this.addEnv(key, spec));
    this.harnesses = new HarnessBuilder(this.plan, this.layout.container, {
      addLanguage: (name, options) => this.addLanguage(name, options),
      addAptPackage: (name) => this.build.addAptPackage(name),
      addLanguageSnippet: (snippet) => this.build.addLanguageSnippet(snippet),
      addProcess: (spec) => this.addProcess(spec),
      addEnv: (key, spec) => this.addEnv(key, spec),
    });
    this.mcp = new McpBuilder(this.plan, this.layout.container, {
      addLanguage: (name, options) => this.addLanguage(name, options),
      addProcess: (spec) => this.addProcess(spec),
      volumeCredentialEnvironment: () => this.volumes.mcpCredentialEnvironment(),
      providerCredentialEnvironment: () => this.providers.mcpCredentialEnvironment(),
    });
    this.addEndpoint = this.providers.addEndpoint.bind(this.providers);
    this.addProvider = this.providers.addProvider.bind(this.providers);
    this.addMcpProvider = this.providers.addMcpProvider.bind(this.providers);
    this.addJiraProvider = this.providers.addJiraProvider.bind(this.providers);
    this.addLinearProvider = this.providers.addLinearProvider.bind(this.providers);
    this.addSentryProvider = this.providers.addSentryProvider.bind(this.providers);
    this.addSlackProvider = this.providers.addSlackProvider.bind(this.providers);
    this.addGithubProvider = this.providers.addGithubProvider.bind(this.providers);
    this.addLlmProvider = this.providers.addLlmProvider.bind(this.providers);
    this.addOpencodeHarness = this.harnesses.addOpencodeHarness.bind(this.harnesses);
    this.addPiHarness = this.harnesses.addPiHarness.bind(this.harnesses);
    this.addCodexHarness = this.harnesses.addCodexHarness.bind(this.harnesses);
    this.addClaudeHarness = this.harnesses.addClaudeHarness.bind(this.harnesses);
  }

  addProcess(spec: ProcessSpec): void {
    this.processes.addProcess(spec);
  }

  addHook(spec: HookSpec): void {
    this.processes.addHook(spec);
  }

  addLanguage(name: string, options: LanguageOptions = {}): void {
    this.build.addLanguage(name, options);
  }

  finalizeBuildPlan(): void {
    this.build.finalize();
  }

  addPackage(manager: string, name: string, options: PackageOptions = {}): void {
    this.build.addPackage(manager, name, options);
  }

  addTool(name: string, options: ToolOptions = {}): void {
    this.build.addTool(name, options);
  }

  addAptPackage(name: string): void {
    this.build.addAptPackage(name);
  }

  addService(name: string, options: ServiceOptions = {}): void {
    this.services.add(name, options);
  }

  addEnv(key: string, spec: EnvSpec): void {
    this.environment.add(key, spec);
  }

  addVolume(spec: VolumeSpec): void {
    this.volumes.add(spec);
  }

  addRepo(spec: RepoSpec): void {
    this.repositories.add(spec);
  }

  addLocalVolume(spec: LocalVolumeSpec): void {
    this.volumes.addLocal(spec);
  }

  addS3Volume(spec: S3VolumeSpec): void {
    this.volumes.addS3(spec);
  }

  addGcsVolume(spec: GcsVolumeSpec): void {
    this.volumes.addGcs(spec);
  }

  addAzureVolume(spec: AzureVolumeSpec): void {
    this.volumes.addAzure(spec);
  }

  addSftpVolume(spec: SftpVolumeSpec): void {
    this.volumes.addSftp(spec);
  }

  addSmbVolume(spec: SmbVolumeSpec): void {
    this.volumes.addSmb(spec);
  }

  addWebdavVolume(spec: WebdavVolumeSpec): void {
    this.volumes.addWebdav(spec);
  }

  addDropboxVolume(spec: DropboxVolumeSpec): void {
    this.volumes.addDropbox(spec);
  }

  addGdriveVolume(spec: GdriveVolumeSpec): void {
    this.volumes.addGdrive(spec);
  }

  fileExists(path: string): boolean {
    return this.io.fileExists(path);
  }

  readFile(path: string): string {
    return this.io.readFile(path);
  }

  readJSON(path: string): unknown {
    return this.io.readJSON(path);
  }

  exec(command: string): { stdout: string; stderr: string; exitCode: number } {
    if (this.dryRun) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    console.log(`[exec] ${command}`);
    return this.io.exec(command);
  }

  configureMcp(port: number, options: McpOptions = {}): void {
    this.mcp.configure(port, options);
  }
}
