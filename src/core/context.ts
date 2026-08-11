import { Schema } from "effect";
import {
  createPlan,
  Plan,
  DependencyInstall,
  CopyArtifact,
  AgentHarnessSpecSchema,
  AgentHarness,
  PiHarnessSpecSchema,
  PiHarness,
  CodexHarnessSpecSchema,
  CodexHarness,
  ClaudeHarnessSpecSchema,
  ClaudeHarness,
} from "./plan.js";
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
  AgentHarnessSpec,
  PiHarnessSpec,
  CodexHarnessSpec,
  ClaudeHarnessSpec,
} from "./feature.js";
import { BuildContext } from "./build-context.js";
import { languageHandlers, getDefaultBaseImage } from "./languages.js";
import { formatPackage } from "./packages.js";
import { toolHandlers } from "./tools.js";
import { ValidationError } from "./errors.js";
import { runtimeLayout } from "../runtime/layout.js";
import { createNodeProjectIO, type ProjectIO } from "./plan-builder/project-io.js";
import { EnvironmentBuilder } from "./plan-builder/environment.js";
import { ProcessBuilder } from "./plan-builder/processes.js";
import { ServiceBuilder } from "./plan-builder/services.js";
import { RepositoryBuilder } from "./plan-builder/repositories.js";
import { VolumeBuilder } from "./plan-builder/volumes.js";
import { ProviderBuilder } from "./plan-builder/providers.js";

function validatePort(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ValidationError({ message: `${label} must be an integer between 1 and 65535` });
  }
}

export class SandboxContext implements FeatureContext, BuildContext {
  plan: Plan;
  private readonly layout = runtimeLayout("");
  private dryRun: boolean;
  private io: ProjectIO;
  private environment: EnvironmentBuilder;
  private processes: ProcessBuilder;
  private services: ServiceBuilder;
  private repositories: RepositoryBuilder;
  private volumes: VolumeBuilder;
  private providers: ProviderBuilder;
  readonly addEndpoint: FeatureContext["addEndpoint"];
  readonly addProvider: FeatureContext["addProvider"];
  readonly addMcpProvider: FeatureContext["addMcpProvider"];
  readonly addJiraProvider: FeatureContext["addJiraProvider"];
  readonly addLinearProvider: FeatureContext["addLinearProvider"];
  readonly addSentryProvider: FeatureContext["addSentryProvider"];
  readonly addSlackProvider: FeatureContext["addSlackProvider"];
  readonly addGithubProvider: FeatureContext["addGithubProvider"];
  readonly addLlmProvider: FeatureContext["addLlmProvider"];

  constructor(
    rootDir: string,
    project: string,
    dryRun = false,
    io: ProjectIO = createNodeProjectIO(rootDir),
  ) {
    this.dryRun = dryRun;
    this.io = io;
    this.plan = createPlan(project);
    this.environment = new EnvironmentBuilder(this.plan);
    this.processes = new ProcessBuilder(this.plan, (name) => this.addAptPackage(name));
    this.services = new ServiceBuilder(this.plan);
    this.repositories = new RepositoryBuilder(
      this.plan,
      (name) => this.addAptPackage(name),
      (spec) => this.addHook(spec),
      this.layout.container.repositories,
    );
    this.volumes = new VolumeBuilder(
      this.plan,
      (name) => this.addAptPackage(name),
      (spec) => this.addProcess(spec),
    );
    this.providers = new ProviderBuilder(this.plan, (key, spec) => this.addEnv(key, spec));
    this.addEndpoint = this.providers.addEndpoint.bind(this.providers);
    this.addProvider = this.providers.addProvider.bind(this.providers);
    this.addMcpProvider = this.providers.addMcpProvider.bind(this.providers);
    this.addJiraProvider = this.providers.addJiraProvider.bind(this.providers);
    this.addLinearProvider = this.providers.addLinearProvider.bind(this.providers);
    this.addSentryProvider = this.providers.addSentryProvider.bind(this.providers);
    this.addSlackProvider = this.providers.addSlackProvider.bind(this.providers);
    this.addGithubProvider = this.providers.addGithubProvider.bind(this.providers);
    this.addLlmProvider = this.providers.addLlmProvider.bind(this.providers);
  }

  addProcess(spec: ProcessSpec): void {
    this.processes.addProcess(spec);
  }

  addHook(spec: HookSpec): void {
    this.processes.addHook(spec);
  }

  addLanguage(name: string, options: LanguageOptions = {}): void {
    if (!languageHandlers[name]) {
      return;
    }
    const existing = this.plan.build.languageRequests.findIndex((r) => r.name === name);
    if (existing >= 0) {
      this.plan.build.languageRequests[existing] = { name, options };
    } else {
      this.plan.build.languageRequests.push({ name, options });
    }
  }

  finalizeBuildPlan(): void {
    const requests = this.plan.build.languageRequests;

    if (requests.length === 0) {
      this.setBaseImage(getDefaultBaseImage());
      return;
    }

    if (requests.length === 1) {
      const { name, options } = requests[0];
      const handler = languageHandlers[name];
      if (handler) {
        this.setBaseImage(handler.baseImage(options));
        handler.installDependencies(this, options);
      }
      return;
    }

    // Multiple languages: use the neutral base image and install every runtime.
    this.setBaseImage(getDefaultBaseImage());
    for (const { name, options } of requests) {
      const handler = languageHandlers[name];
      if (!handler) continue;
      handler.installRuntime(this, options);
      handler.installDependencies(this, options);
    }
  }

  addPackage(manager: string, name: string, options: PackageOptions = {}): void {
    if (!name || typeof name !== "string") {
      throw new ValidationError({ message: "Package requires a non-empty string name" });
    }
    const registryFlag = options.indexUrl ? ` --registry ${options.indexUrl}` : "";
    const indexUrlFlag = options.indexUrl ? ` --index-url ${options.indexUrl}` : "";

    const commands: Record<string, string> = {
      npm: `npm install -g${registryFlag} ${formatPackage(name, options)}`,
      pip: `pip install --no-cache-dir${indexUrlFlag} ${formatPackage(name, options, "==")}`,
      cargo: `cargo install ${name}`,
      go: `go install ${name}@latest`,
      gem: `gem install ${name}`,
    };

    const command = commands[manager];
    if (!command) {
      throw new ValidationError({ message: `Unknown package manager ${manager}` });
    }
    this.addLanguageSnippet(`RUN ${command}`);
  }

  addTool(name: string, _options: ToolOptions = {}): void {
    if (!name || typeof name !== "string") {
      throw new ValidationError({ message: "Tool requires a non-empty string name" });
    }
    const handler = toolHandlers[name];
    if (handler) {
      handler(this);
    } else {
      // Unknown tools are treated as apt packages.
      this.addAptPackage(name);
    }
  }

  addAptPackage(name: string): void {
    if (!this.plan.build.aptPackages.includes(name)) {
      this.plan.build.aptPackages.push(name);
    }
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

  addOpencodeHarness(spec: AgentHarnessSpec): void {
    const validated = Schema.decodeSync(AgentHarnessSpecSchema)(spec);

    if (this.plan.runtime.agentHarnesses.some((h) => h.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate agent harness name: ${validated.name}` });
    }

    const port = validated.port ?? 3002;
    validatePort(port, `Agent harness ${validated.name}: port`);

    const mcpServers = validated.mcpServers ?? {
      biodome: { url: `http://localhost:${this.plan.build.mcpPort}` },
    };

    const telemetry = {
      enabled: validated.telemetry?.enabled ?? true,
      path: validated.telemetry?.path ?? `${this.layout.container.logs}/opencode-events.jsonl`,
      capturePayloads: validated.telemetry?.capturePayloads ?? false,
    };

    const harness: AgentHarness = {
      name: validated.name,
      type: "opencode",
      port,
      mcpServers,
      telemetry,
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.agentHarnesses.push(harness);

    // OpenCode CLI runs on Bun and is distributed through npm as opencode-ai.
    this.addLanguage("node", { version: "20" });
    this.addAptPackage("curl");
    this.addAptPackage("ca-certificates");
    this.addAptPackage("unzip");
    this.addLanguageSnippet("RUN npm install -g opencode-ai");
    this.addLanguageSnippet(
      "RUN curl -fsSL -o /tmp/bun-install.sh https://bun.sh/install && bash /tmp/bun-install.sh && rm /tmp/bun-install.sh && ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
    );

    this.addProcess({
      name: `opencode-agent-${validated.name}`,
      command: ["sh", `${this.layout.container.opencodeHomes}/${validated.name}/start.sh`],
      port,
      healthCheck: { type: "http", url: `http://localhost:${port}/health` },
      environment: {
        // OpenCode hard-codes config paths under ~/.config/opencode. Point
        // HOME at a generated per-harness directory so the sandbox ships its
        // own isolated config (plugins, MCP servers, provider) instead of
        // relying on the host's ~/.config.
        HOME: `${this.layout.container.opencodeHomes}/${validated.name}`,
        OPENCODE_TELEMETRY_PATH: telemetry.path,
      },
    });
  }

  addPiHarness(spec: PiHarnessSpec): void {
    const validated = Schema.decodeSync(PiHarnessSpecSchema)(spec);

    if (this.plan.runtime.piHarnesses.some((h) => h.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate Pi harness name: ${validated.name}` });
    }

    if (validated.apiKey && typeof validated.apiKey === "string") {
      throw new ValidationError({
        message: `Pi harness ${validated.name}: apiKey must be an environment reference ({ env: "VAR" }), not a literal string`,
      });
    }

    const telemetry = {
      enabled: validated.telemetry?.enabled ?? true,
      path:
        validated.telemetry?.path ??
        `${this.layout.container.logs}/pi-${validated.name}-events.jsonl`,
      capturePayloads: validated.telemetry?.capturePayloads ?? false,
    };

    const harness: PiHarness = {
      name: validated.name,
      type: "pi",
      provider: validated.provider,
      model: validated.model,
      apiKey: validated.apiKey,
      tools: validated.tools ? [...validated.tools] : undefined,
      extensions: validated.extensions ? [...validated.extensions] : undefined,
      skills: validated.skills ? [...validated.skills] : undefined,
      prompts: validated.prompts ? [...validated.prompts] : undefined,
      themes: validated.themes ? [...validated.themes] : undefined,
      packages: validated.packages ? [...validated.packages] : undefined,
      telemetry,
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.piHarnesses.push(harness);

    // Pi is distributed as an npm package.
    this.addLanguage("node", { version: "20" });
    this.addLanguageSnippet("RUN npm install -g @earendil-works/pi-coding-agent");

    // Passthrough the API key env reference so Docker Compose injects it into
    // the container; the wrapper script then exports it for pi.
    if (validated.apiKey && typeof validated.apiKey === "object" && "env" in validated.apiKey) {
      this.addEnv(validated.apiKey.env, { from: { env: validated.apiKey.env } });
    }
  }

  addCodexHarness(spec: CodexHarnessSpec): void {
    const validated = Schema.decodeSync(CodexHarnessSpecSchema)(spec);

    if (this.plan.runtime.codexHarnesses.some((h) => h.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate Codex harness name: ${validated.name}` });
    }

    if (validated.apiKey && typeof validated.apiKey === "string") {
      throw new ValidationError({
        message: `Codex harness ${validated.name}: apiKey must be an environment reference ({ env: "VAR" }), not a literal string`,
      });
    }

    const port = validated.port ?? 3003;
    validatePort(port, `Codex harness ${validated.name}: port`);

    const mcpServers = validated.mcpServers ?? {
      biodome: { url: `http://localhost:${this.plan.build.mcpPort}` },
    };

    const telemetry = {
      enabled: validated.telemetry?.enabled ?? true,
      path:
        validated.telemetry?.path ??
        `${this.layout.container.logs}/codex-${validated.name}-events.jsonl`,
      capturePayloads: validated.telemetry?.capturePayloads ?? false,
    };

    const harness: CodexHarness = {
      name: validated.name,
      type: "codex",
      port,
      mcpServers,
      apiKey: validated.apiKey,
      model: validated.model,
      telemetry,
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.codexHarnesses.push(harness);

    // Codex CLI runs on Node and is distributed through npm as @openai/codex.
    this.addLanguage("node", { version: "20" });
    this.addAptPackage("git");
    this.addLanguageSnippet("RUN npm install -g @openai/codex");

    this.addProcess({
      name: `codex-agent-${validated.name}`,
      command: ["sh", `${this.layout.container.codexHomes}/${validated.name}/start.sh`],
      port,
      healthCheck: { type: "tcp", port },
      environment: {
        HOME: `${this.layout.container.codexHomes}/${validated.name}`,
        CODEX_BIODOME_TELEMETRY_PATH: telemetry.path,
      },
      mergeEnv: false,
    });

    // Passthrough the API key env reference so Docker Compose injects it into
    // the container; the harness start script runs Codex with it.
    if (harness.apiKey && typeof harness.apiKey === "object" && "env" in harness.apiKey) {
      this.addEnv(harness.apiKey.env, { from: { env: harness.apiKey.env } });
    }
  }

  addClaudeHarness(spec: ClaudeHarnessSpec): void {
    const validated = Schema.decodeSync(ClaudeHarnessSpecSchema)(spec);

    if (this.plan.runtime.claudeHarnesses.some((h) => h.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate Claude harness name: ${validated.name}` });
    }

    if (validated.apiKey && typeof validated.apiKey === "string") {
      throw new ValidationError({
        message: `Claude harness ${validated.name}: apiKey must be an environment reference ({ env: "VAR" }), not a literal string`,
      });
    }

    const telemetry = {
      enabled: validated.telemetry?.enabled ?? true,
      path:
        validated.telemetry?.path ??
        `${this.layout.container.logs}/claude-${validated.name}-events.jsonl`,
      capturePayloads: validated.telemetry?.capturePayloads ?? false,
    };

    const harness: ClaudeHarness = {
      name: validated.name,
      type: "claude",
      apiKey: validated.apiKey,
      model: validated.model,
      tools: validated.tools ? [...validated.tools] : undefined,
      permissions: validated.permissions,
      telemetry,
      config: validated.config ? { ...validated.config } : {},
    };
    this.plan.runtime.claudeHarnesses.push(harness);

    // Claude Code runs on Node and is distributed through npm as @anthropic-ai/claude-code.
    this.addLanguage("node", { version: "20" });
    this.addAptPackage("git");
    this.addLanguageSnippet("RUN npm install -g @anthropic-ai/claude-code");

    // Passthrough the API key env reference so Docker Compose injects it into
    // the container; the wrapper script then exports it for claude.
    if (harness.apiKey && typeof harness.apiKey === "object" && "env" in harness.apiKey) {
      this.addEnv(harness.apiKey.env, { from: { env: harness.apiKey.env } });
    }
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

  // BuildContext helpers — encapsulate plan mutations.

  setBaseImage(name: string): boolean {
    if (this.plan.build.baseImage) {
      return false;
    }
    this.plan.build.baseImage = name;
    return true;
  }

  requireDependencyFiles(files: string[]): string[] {
    const existing: string[] = [];
    for (const file of files) {
      if (this.fileExists(file)) {
        existing.push(file);
        if (!this.plan.build.dependencyFiles.includes(file)) {
          this.plan.build.dependencyFiles.push(file);
        }
      }
    }
    return existing;
  }

  addDependencyInstall(install: DependencyInstall): void {
    this.plan.build.dependencyInstalls.push(install);
  }

  addCopyArtifact(artifact: CopyArtifact): void {
    this.plan.build.copyArtifacts.push(artifact);
  }

  addRuntimeInstall(snippet: string): void {
    if (!this.plan.build.runtimeInstalls.includes(snippet)) {
      this.plan.build.runtimeInstalls.push(snippet);
    }
  }

  addLanguageSnippet(snippet: string): void {
    if (!this.plan.build.languageSnippets.includes(snippet)) {
      this.plan.build.languageSnippets.push(snippet);
    }
  }

  enableNodeModulesVolume(): void {
    this.plan.build.nodeModulesVolume = true;
  }

  enableVenvVolume(): void {
    this.plan.build.venvVolume = true;
  }

  enableVendorVolume(): void {
    this.plan.build.vendorVolume = true;
  }

  configureMcp(
    port: number,
    config?: {
      token?: { env: string };
      allowExec?: boolean;
      allowProcessControl?: boolean;
      maxReadBytes?: number;
      maxWriteBytes?: number;
      maxListEntries?: number;
      providerConnectTimeoutMs?: number;
      providerRequestTimeoutMs?: number;
      providerCatalogConcurrency?: number;
    },
  ): void {
    this.plan.build.mcpEnabled = true;
    this.plan.build.mcpPort = port;
    this.plan.build.mcpConfig.enabled = true;
    this.plan.build.mcpConfig.port = port;

    if (config) {
      if (config.token) {
        if (typeof config.token === "string") {
          throw new ValidationError({
            message: 'MCP token must be an environment variable reference ({ env: "VAR" })',
          });
        }
        this.plan.build.mcpConfig.token = { env: config.token.env };
      }
      if (config.allowExec !== undefined) {
        this.plan.build.mcpConfig.allowExec = config.allowExec;
      }
      if (config.allowProcessControl !== undefined) {
        this.plan.build.mcpConfig.allowProcessControl = config.allowProcessControl;
      }
      if (config.maxReadBytes !== undefined) {
        this.plan.build.mcpConfig.maxReadBytes = config.maxReadBytes;
      }
      if (config.maxWriteBytes !== undefined) {
        this.plan.build.mcpConfig.maxWriteBytes = config.maxWriteBytes;
      }
      if (config.maxListEntries !== undefined) {
        this.plan.build.mcpConfig.maxListEntries = config.maxListEntries;
      }
      if (config.providerConnectTimeoutMs !== undefined) {
        this.plan.build.mcpConfig.providerConnectTimeoutMs = config.providerConnectTimeoutMs;
      }
      if (config.providerRequestTimeoutMs !== undefined) {
        this.plan.build.mcpConfig.providerRequestTimeoutMs = config.providerRequestTimeoutMs;
      }
      if (config.providerCatalogConcurrency !== undefined) {
        this.plan.build.mcpConfig.providerCatalogConcurrency = config.providerCatalogConcurrency;
      }
    }

    // The MCP server is a Node script. Ensure a Node runtime is present without
    // clobbering an explicit node request the user may already have made.
    const hasNode = this.plan.build.languageRequests.some((r) => r.name === "node");
    if (!hasNode) {
      this.addLanguage("node", { version: "20" });
    }

    // Collect proxy-volume and provider credential env references so the MCP
    // server can resolve them at runtime. Keep them isolated to the MCP process
    // so they are not merged into the dev service's global environment.
    const mcpEnvironment: Record<string, string> = {};
    for (const volume of this.plan.runtime.volumes) {
      if (!volume.proxy) continue;
      if (!volume.credentials) continue;
      for (const value of Object.values(volume.credentials)) {
        if (typeof value === "string") continue;
        mcpEnvironment[value.env] = `\${${value.env}}`;
      }
    }
    Object.assign(mcpEnvironment, this.providers.mcpCredentialEnvironment());

    // Include the MCP token env var so it reaches the MCP server process at runtime.
    const token = this.plan.build.mcpConfig.token;
    if (token && typeof token === "object") {
      mcpEnvironment[token.env] = `\${${token.env}}`;
    }

    this.addProcess({
      name: "biodome-mcp",
      command: [
        "node",
        this.layout.container.mcpServer,
        "--port",
        String(port),
        "--plan",
        this.layout.container.mcpPlan,
      ],
      port,
      healthCheck: { type: "http", url: `http://localhost:${port}/health` },
      environment: {
        ...mcpEnvironment,
        MCP_EVENTS_LOG: `${this.layout.container.logs}/mcp-events.jsonl`,
      },
      mergeEnv: false,
    });
  }
}
