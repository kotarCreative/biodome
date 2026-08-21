import { createPlan, PlanSchema } from "../../core/plan.js";
import { canonicalPlanSchemaContract } from "./lib/plan.js";

const plan = createPlan("complete-schema-contract");
plan.deployment = {
  target: { name: "staging", driver: "aws-ecs", options: { region: "us-east-1", cpu: 1024 } },
  deploymentId: "complete-schema-contract-staging",
  task: {
    name: "review",
    harness: "reviewer",
    prompt: "Review the repository",
    artifacts: ["reports/review.md"],
    timeout: "10m",
    cleanup: "on-success",
    requiredServices: ["postgres"],
    requiredProcesses: ["web"],
    capabilities: [{ capability: "exec.inplace", level: "required", reason: "runs checks" }],
    resources: { cpu: 1024, memoryMiB: 2048, diskMiB: 4096 },
    network: { mode: "egress", allow: ["registry.npmjs.org"] },
    workspace: { strategy: "clone", repository: "app", ref: "main", path: "/workspace" },
    validationCommands: [["npm", "test"]],
  },
};
plan.build = {
  project: plan.project,
  baseImage: "node:22-slim",
  aptPackages: ["git"],
  runtimeInstalls: ["corepack enable"],
  languageSnippets: ["RUN node --version"],
  languageRequests: [{ name: "node", options: { version: "22", packageManager: "npm" } }],
  dependencyFiles: ["package.json"],
  dependencyInstalls: [{ files: ["package.json"], command: "npm ci" }],
  copyArtifacts: [{ files: ["dist"], lines: ["COPY dist /workspace/dist"] }],
  environment: { BUILD_MODE: "test" },
  nodeModulesVolume: true,
  venvVolume: true,
  vendorVolume: true,
  mcpEnabled: true,
  mcpPort: 3001,
  mcpConfig: {
    enabled: true,
    port: 3001,
    token: { env: "MCP_TOKEN" },
    allowExec: true,
    allowProcessControl: true,
    commandTimeoutMs: 30000,
    commandStdoutMaxBytes: 1048576,
    commandStderrMaxBytes: 1048576,
    maxReadBytes: 1024,
    maxWriteBytes: 2048,
    maxListEntries: 10,
    providerConnectTimeoutMs: 1000,
    providerRequestTimeoutMs: 2000,
    providerCatalogConcurrency: 2,
  },
};
plan.runtime.services.push({
  name: "postgres",
  type: "postgres",
  environment: { POSTGRES_PASSWORD: "postgres" },
  ports: [{ host: 5432, container: 5432 }],
});
plan.runtime.volumes.push(
  { name: "local", type: "local", source: "./data", target: "/data" },
  {
    name: "s3",
    type: "s3",
    bucket: "bucket",
    target: "/s3",
    credentials: { token: { env: "S3_TOKEN" } },
  },
  { name: "gcs", type: "gcs", bucket: "bucket", target: "/gcs" },
  { name: "azure", type: "azure", account: "account", container: "container", target: "/azure" },
  { name: "sftp", type: "sftp", host: "host", path: "/remote", target: "/sftp" },
  { name: "smb", type: "smb", host: "host", share: "share", target: "/smb" },
  { name: "webdav", type: "webdav", url: "https://example.test", target: "/webdav" },
  { name: "dropbox", type: "dropbox", path: "/dropbox", target: "/dropbox" },
  { name: "gdrive", type: "gdrive", path: "/gdrive", target: "/gdrive" },
);
plan.runtime.ports.push({ name: "web", host: 3000, container: 3000 });
plan.runtime.environment = { NODE_ENV: "test" };
plan.runtime.envVars.push(
  { key: "MODE", scope: "runtime", value: "test" },
  { key: "API_TOKEN", scope: "both", from: { env: "API_TOKEN" }, required: true },
);
plan.runtime.processes.push({
  name: "web",
  command: ["node", "server.js"],
  ports: [{ name: "web", host: 3000, container: 3000 }],
  environment: { PORT: "3000" },
  workingDir: "/workspace",
  healthCheck: { type: "http", url: "http://localhost:3000", interval: "5s" },
  mode: "daemon",
  startOn: "start.post",
  mergeEnv: true,
});
plan.runtime.endpoints.push({
  name: "api",
  url: "http://localhost:3000",
  credentials: { token: { env: "API_TOKEN" } },
});
plan.runtime.providers.push({
  name: "issues",
  type: "github",
  mcpUrl: "https://example.test/mcp",
  credentials: { token: { env: "API_TOKEN" } },
});
plan.runtime.repos.push({
  name: "app",
  url: "https://example.test/app.git",
  path: "app",
  branch: "main",
  depth: 1,
  credentials: { sshKey: { env: "SSH_KEY" } },
});
plan.runtime.agentHarnesses.push({
  name: "agent",
  type: "opencode",
  port: 4096,
  mcpServers: { local: { url: "http://localhost:3001/mcp" } },
  telemetry: { enabled: true, path: "/logs/events.jsonl", capturePayloads: false },
  config: { theme: "dark" },
});
plan.runtime.piHarnesses.push({
  name: "reviewer",
  type: "pi",
  provider: "openai",
  model: "gpt",
  apiKey: { env: "OPENAI_API_KEY" },
  tools: ["read"],
  telemetry: { enabled: false, path: "/logs/pi.jsonl" },
  config: {},
});
plan.runtime.codexHarnesses.push({
  name: "codex",
  type: "codex",
  port: 4097,
  mcpServers: {},
  apiKey: { env: "OPENAI_API_KEY" },
  telemetry: { enabled: false, path: "/logs/codex.jsonl" },
  config: {},
});
plan.runtime.claudeHarnesses.push({
  name: "claude",
  type: "claude",
  apiKey: { env: "ANTHROPIC_API_KEY" },
  tools: ["read"],
  permissions: "default",
  telemetry: { enabled: false, path: "/logs/claude.jsonl" },
  config: {},
});
plan.runtime.llmProviders.push({
  name: "openai",
  npm: "@ai-sdk/openai",
  displayName: "OpenAI",
  options: { apiKey: { env: "OPENAI_API_KEY" }, retries: 2, enabled: true },
  models: { fast: { name: "gpt-4.1-mini" } },
});
plan.runtime.applications.push({
  name: "app",
  root: "/workspace/app",
  recipe: { id: "node", version: "1", declarationPath: ".biodome/apps/app.mjs" },
  declarationPath: ".biodome/apps/app.mjs",
  repositories: ["app"],
  hooks: [],
  processes: ["web"],
  endpoints: ["api"],
  requiredServices: ["postgres"],
  dependencies: [],
});
plan.runtime.contributions.push({
  kind: "process",
  qualifiedName: "app:web",
  source: {
    application: "app",
    recipe: "node",
    recipeVersion: "1",
    declarationPath: ".biodome/apps/app.mjs",
    localName: "web",
  },
});

canonicalPlanSchemaContract("Plan", PlanSchema, plan);
