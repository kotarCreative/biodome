import { Schema } from "effect";
import {
  createPlan,
  Plan,
  DependencyInstall,
  CopyArtifact,
  EndpointSpecSchema,
  ProviderSpecSchema,
  VolumeSpecSchema,
  Volume,
  Provider,
  SecretValue,
  AgentHarnessSpecSchema,
  AgentHarness,
  LlmProviderSpecSchema,
  LlmProvider,
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
  EndpointSpec,
  ProviderSpec,
  McpProviderSpec,
  JiraProviderSpec,
  LinearProviderSpec,
  SentryProviderSpec,
  SlackProviderSpec,
  GithubProviderSpec,
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
  LlmProviderSpec,
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

function validatePort(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ValidationError({ message: `${label} must be an integer between 1 and 65535` });
  }
}

function validateEnv(
  env: Record<string, unknown>,
  label: string,
): asserts env is Record<string, string> {
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new ValidationError({ message: `${label} must be a record of strings` });
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new ValidationError({ message: `${label}.${key} must be a string` });
    }
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

  addEndpoint(spec: EndpointSpec): void {
    const validated = Schema.decodeSync(EndpointSpecSchema)(spec);
    if (validated.port !== undefined)
      validatePort(validated.port, `Endpoint ${validated.name}: port`);
    if (validated.metadata) {
      validateEnv(
        validated.metadata as Record<string, unknown>,
        `Endpoint ${validated.name}: metadata`,
      );
    }

    if (this.plan.runtime.endpoints.some((e) => e.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate endpoint name: ${validated.name}` });
    }

    this.plan.runtime.endpoints.push({
      name: validated.name,
      description: validated.description,
      url: validated.url,
      port: validated.port,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
      metadata: validated.metadata ? { ...validated.metadata } : undefined,
    });
  }

  addProvider(spec: ProviderSpec): void {
    const validated = Schema.decodeSync(ProviderSpecSchema)(spec);
    if (validated.metadata) {
      validateEnv(
        validated.metadata as Record<string, unknown>,
        `Provider ${validated.name}: metadata`,
      );
    }

    if (this.plan.runtime.providers.some((p) => p.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate provider name: ${validated.name}` });
    }

    // Reject literal credential values for providers; require env refs.
    if (validated.credentials) {
      for (const [key, value] of Object.entries(validated.credentials)) {
        if (typeof value === "string") {
          throw new ValidationError({
            message: `Provider ${validated.name}: credentials.${key} must be an environment reference ({ env: "VAR" }), not a literal string`,
          });
        }
      }
    }

    const provider: Provider = {
      name: validated.name,
      type: validated.type,
      url: validated.url,
      project: validated.project,
      mcpUrl: validated.mcpUrl,
      authHeader: validated.authHeader,
      authScheme: validated.authScheme,
      authCredential: validated.authCredential,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
      metadata: validated.metadata ? { ...validated.metadata } : undefined,
    };
    this.plan.runtime.providers.push(provider);
  }

  addMcpProvider(spec: McpProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "MCP provider requires a name" });
    if (!spec.mcpUrl)
      throw new ValidationError({ message: `Provider ${spec.name}: mcpUrl is required` });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addProvider({
      name: spec.name,
      type: spec.type,
      mcpUrl: spec.mcpUrl,
      authHeader: spec.authHeader ?? "Authorization",
      authScheme: spec.authScheme ?? "Bearer ",
      authCredential: "token",
      project: spec.project,
      credentials: { token: spec.credentials.token },
      metadata: spec.metadata,
    });
  }

  addJiraProvider(spec: JiraProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "Jira provider requires a name" });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Jira provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "jira",
      mcpUrl: spec.mcpUrl ?? "https://mcp.atlassian.com/v1/mcp/authv2",
      project: spec.project,
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addLinearProvider(spec: LinearProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "Linear provider requires a name" });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Linear provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "linear",
      mcpUrl: spec.mcpUrl ?? "https://mcp.linear.app/mcp",
      project: spec.team,
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addSentryProvider(spec: SentryProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "Sentry provider requires a name" });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Sentry provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "sentry",
      mcpUrl: spec.mcpUrl ?? "https://mcp.sentry.dev/mcp",
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addSlackProvider(spec: SlackProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "Slack provider requires a name" });
    if (!spec.mcpUrl)
      throw new ValidationError({ message: `Slack provider ${spec.name}: mcpUrl is required` });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `Slack provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "slack",
      mcpUrl: spec.mcpUrl,
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addGithubProvider(spec: GithubProviderSpec): void {
    if (!spec.name) throw new ValidationError({ message: "GitHub provider requires a name" });
    if (!spec.credentials?.token) {
      throw new ValidationError({
        message: `GitHub provider ${spec.name}: credentials.token is required`,
      });
    }
    this.addMcpProvider({
      name: spec.name,
      type: "github",
      mcpUrl: spec.mcpUrl ?? "https://api.githubcopilot.com/mcp/",
      credentials: spec.credentials,
      metadata: spec.metadata,
    });
  }

  addEnv(key: string, spec: EnvSpec): void {
    this.environment.add(key, spec);
  }

  addVolume(spec: VolumeSpec): void {
    const validated = Schema.decodeSync(VolumeSpecSchema)(spec);

    if (this.plan.runtime.volumes.some((v) => v.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate volume name: ${validated.name}` });
    }

    this.validateVolumeSpec(validated);

    const readOnly = validated.readOnly || validated.options?.readOnly === "true";

    const volume: Volume = {
      ...validated,
      readOnly,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
      options: validated.options ? { ...validated.options } : undefined,
      allowedPaths: validated.allowedPaths ? [...validated.allowedPaths] : undefined,
    };

    this.plan.runtime.volumes.push(volume);

    if (validated.proxy) {
      // Proxy volumes are accessed through the MCP server, not mounted.
      return;
    }

    if (validated.type === "local") {
      // Local bind mounts are emitted directly in compose; nothing else to do.
      return;
    }

    // Cloud-backed volumes use rclone. Ensure it and FUSE are available.
    this.addAptPackage("rclone");
    this.addAptPackage("fuse3");

    const env = this.buildRcloneEnv(volume);

    // Bucket/folder mounts run as a daemon process.
    const remote = this.rcloneRemote(volume);
    const command = [
      "rclone",
      "mount",
      remote,
      validated.target,
      "--allow-other",
      "--vfs-cache-mode",
      "writes",
    ];
    if (readOnly) {
      command.push("--read-only");
    }
    this.addProcess({
      name: `rclone-mount-${validated.name}`,
      command,
      environment: env,
    });
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

  addLlmProvider(spec: LlmProviderSpec): void {
    const validated = Schema.decodeSync(LlmProviderSpecSchema)(spec);

    if (this.plan.runtime.llmProviders.some((p) => p.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate LLM provider name: ${validated.name}` });
    }

    const provider: LlmProvider = {
      name: validated.name,
      npm: validated.npm,
      displayName: validated.displayName,
      options: validated.options ? { ...validated.options } : {},
      models: validated.models ? { ...validated.models } : {},
    };

    // Reject literal credential strings in provider options to keep secrets out
    // of plan.json and generated config files.
    for (const [key, value] of Object.entries(provider.options)) {
      if (typeof value === "string" && key.toLowerCase().includes("key")) {
        throw new ValidationError({
          message: `LLM provider ${validated.name}: option "${key}" looks like a credential and must be an environment reference ({ env: "VAR" }), not a literal string`,
        });
      }
    }

    // Passthrough env-referenced options so Docker Compose injects them into the
    // container at runtime; the harness start script then substitutes them into
    // the generated OpenCode config.
    for (const value of Object.values(provider.options)) {
      if (value !== undefined && typeof value === "object" && "env" in value) {
        this.addEnv(value.env, { from: { env: value.env } });
      }
    }

    this.plan.runtime.llmProviders.push(provider);
  }

  private validateVolumeSpec(spec: VolumeSpec): void {
    switch (spec.type) {
      case "local": {
        if (!spec.source) {
          throw new ValidationError({
            message: `Volume ${spec.name}: local volumes require a source path`,
          });
        }
        break;
      }
      case "s3":
      case "gcs": {
        if (!spec.bucket) {
          const label = spec.type === "s3" ? "S3" : "GCS";
          throw new ValidationError({
            message: `Volume ${spec.name}: ${label} volumes require a bucket`,
          });
        }
        break;
      }
      case "azure": {
        if (!spec.account) {
          throw new ValidationError({
            message: `Volume ${spec.name}: azure volumes require an account`,
          });
        }
        if (!spec.container) {
          throw new ValidationError({
            message: `Volume ${spec.name}: azure volumes require a container`,
          });
        }
        break;
      }
      case "sftp": {
        if (!spec.host) {
          throw new ValidationError({
            message: `Volume ${spec.name}: sftp volumes require a host`,
          });
        }
        if (!spec.path) {
          throw new ValidationError({
            message: `Volume ${spec.name}: sftp volumes require a path`,
          });
        }
        break;
      }
      case "smb": {
        if (!spec.host) {
          throw new ValidationError({ message: `Volume ${spec.name}: smb volumes require a host` });
        }
        if (!spec.share) {
          throw new ValidationError({
            message: `Volume ${spec.name}: smb volumes require a share`,
          });
        }
        break;
      }
      case "webdav": {
        if (!spec.url) {
          throw new ValidationError({
            message: `Volume ${spec.name}: webdav volumes require a url`,
          });
        }
        break;
      }
      case "dropbox":
      case "gdrive": {
        if (!spec.path) {
          throw new ValidationError({
            message: `Volume ${spec.name}: ${spec.type} volumes require a path`,
          });
        }
        break;
      }
    }
  }

  private rcloneRemote(volume: Volume): string {
    switch (volume.type) {
      case "s3": {
        const prefix = volume.prefix || "";
        return `s3:${volume.bucket}/${prefix}`;
      }
      case "gcs": {
        const prefix = volume.prefix || "";
        return `gcs:${volume.bucket}/${prefix}`;
      }
      case "azure": {
        const path = volume.path || "";
        return `azure:${volume.container}/${path}`;
      }
      case "sftp": {
        return `sftp:${volume.path}`;
      }
      case "smb": {
        return `smb:${volume.host}/${volume.share}`;
      }
      case "webdav": {
        const path = volume.path || "";
        return `webdav:${path}`;
      }
      case "dropbox":
        return `dropbox:${volume.path}`;
      case "gdrive":
        return `drive:${volume.path}`;
      default:
        throw new ValidationError({
          message: `Unsupported volume type for rclone: ${volume.type}`,
        });
    }
  }

  private buildRcloneEnv(volume: Volume): Record<string, string> {
    const env: Record<string, string> = {};
    if (!volume.credentials) return env;

    const mappings: Record<string, Record<string, string>> = {
      s3: {
        accessKeyId: "RCLONE_S3_ACCESS_KEY_ID",
        secretAccessKey: "RCLONE_S3_SECRET_ACCESS_KEY",
        region: "RCLONE_S3_REGION",
        sessionToken: "RCLONE_S3_SESSION_TOKEN",
        endpoint: "RCLONE_S3_ENDPOINT",
      },
      gcs: {
        clientId: "RCLONE_GCS_CLIENT_ID",
        clientSecret: "RCLONE_GCS_CLIENT_SECRET",
        token: "RCLONE_GCS_TOKEN",
        serviceAccountFile: "RCLONE_GCS_SERVICE_ACCOUNT_FILE",
        projectNumber: "RCLONE_GCS_PROJECT_NUMBER",
      },
      azure: {
        accountKey: "RCLONE_AZURE_KEY",
        sasUrl: "RCLONE_AZURE_SAS_URL",
      },
      sftp: {
        user: "RCLONE_SFTP_USER",
        password: "RCLONE_SFTP_PASS",
        keyFile: "RCLONE_SFTP_KEY_FILE",
      },
      smb: {
        user: "RCLONE_SMB_USER",
        password: "RCLONE_SMB_PASS",
        domain: "RCLONE_SMB_DOMAIN",
      },
      webdav: {
        user: "RCLONE_WEBDAV_USER",
        password: "RCLONE_WEBDAV_PASS",
        bearerToken: "RCLONE_WEBDAV_BEARER_TOKEN",
      },
      dropbox: {
        token: "RCLONE_DROPBOX_TOKEN",
      },
      gdrive: {
        clientId: "RCLONE_DRIVE_CLIENT_ID",
        clientSecret: "RCLONE_DRIVE_CLIENT_SECRET",
        token: "RCLONE_DRIVE_TOKEN",
      },
    };

    // Provider-level settings that are not credentials but still configure rclone.
    if (volume.type === "sftp" && volume.host) {
      env.RCLONE_SFTP_HOST = volume.host;
      if (volume.port) env.RCLONE_SFTP_PORT = String(volume.port);
    }
    if (volume.type === "smb" && volume.host) {
      env.RCLONE_SMB_HOST = volume.host;
    }
    if (volume.type === "azure" && volume.account) {
      env.RCLONE_AZURE_ACCOUNT = volume.account;
    }
    if (volume.type === "webdav" && volume.url) {
      env.RCLONE_WEBDAV_URL = volume.url;
      if (volume.vendor) env.RCLONE_WEBDAV_VENDOR = volume.vendor;
    }

    const map = mappings[volume.type];
    for (const [key, value] of Object.entries(volume.credentials)) {
      const rcloneKey = map[key];
      if (!rcloneKey) continue;
      env[rcloneKey] = typeof value === "string" ? value : `\${${value.env}}`;
    }

    return env;
  }

  // Volume wrappers — thin helpers that delegate to addVolume with the right
  // provider-specific shape and credential mapping.

  addLocalVolume(spec: LocalVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "local",
      source: spec.source,
      target: spec.target,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addS3Volume(spec: S3VolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "s3",
      bucket: spec.bucket,
      prefix: spec.prefix,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addGcsVolume(spec: GcsVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "gcs",
      bucket: spec.bucket,
      prefix: spec.prefix,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addAzureVolume(spec: AzureVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "azure",
      account: spec.account,
      container: spec.container,
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addSftpVolume(spec: SftpVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "sftp",
      host: spec.host,
      port: spec.port,
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addSmbVolume(spec: SmbVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "smb",
      host: spec.host,
      share: spec.share,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addWebdavVolume(spec: WebdavVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "webdav",
      url: spec.url,
      path: spec.path,
      target: spec.target,
      vendor: spec.vendor,
      credentials: spec.credentials ? this.normalizeCredentials(spec.credentials) : undefined,
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addDropboxVolume(spec: DropboxVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "dropbox",
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  addGdriveVolume(spec: GdriveVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "gdrive",
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      proxy: spec.proxy,
      readOnly: spec.readOnly,
      allowedPaths: spec.allowedPaths,
    });
  }

  private normalizeCredentials(
    credentials: Record<string, SecretValue | undefined>,
  ): Record<string, SecretValue> {
    const result: Record<string, SecretValue> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
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
    for (const provider of this.plan.runtime.providers) {
      if (!provider.credentials) continue;
      for (const value of Object.values(provider.credentials)) {
        if (typeof value === "string") continue;
        mcpEnvironment[value.env] = `\${${value.env}}`;
      }
    }

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
