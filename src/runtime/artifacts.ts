import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { RuntimeError } from "../core/errors.js";
import type { Plan } from "../core/plan.js";
import { generateDockerfile } from "../docker/generators/dockerfile.js";
import { generateDockerignore } from "../docker/generators/dockerignore.js";
import { generateHealthcheckScripts } from "../docker/generators/healthchecks.js";
import { generateRepoScripts } from "../docker/generators/repositories.js";
import { generateInContainerServiceFiles } from "../docker/generators/services.js";
import { generateSupervisordConf } from "../docker/generators/supervisor.js";
import { generateStartupScript } from "../docker/generators/startup.js";
import { generateClaudeHarnessFiles } from "../docker/generators/harnesses/claude.js";
import { generateCodexHarnessFiles } from "../docker/generators/harnesses/codex.js";
import { generateHarnessFiles } from "../docker/generators/harnesses/opencode.js";
import { generatePiHarnessFiles } from "../docker/generators/harnesses/pi.js";
import { generatePlanJson } from "../mcp/generator.js";
import type { RuntimeLayout } from "./layout.js";

export interface GeneratedFile {
  readonly relativePath: string;
  readonly content?: string;
  readonly sourcePath?: string;
  readonly mode?: number;
  readonly writeMode?: "overwrite" | "if-absent";
}

export const MCP_RUNTIME_FILES = [
  "application.js",
  "auth.js",
  "event-sink.js",
  "plan.js",
  "provider-tools.js",
  "server.js",
  "startup.js",
  "tools/info-provider.js",
  "tools/process-logs.js",
  "tools/types.js",
  "tools/volumes.js",
  "upstream.js",
  "volumes/adapter.js",
  "volumes/azure.js",
  "volumes/gcs.js",
  "volumes/local.js",
  "volumes/s3.js",
] as const;

function textFile(
  projectRoot: string,
  path: string,
  content: string,
  mode?: number,
  writeMode?: GeneratedFile["writeMode"],
): GeneratedFile {
  return { relativePath: relative(projectRoot, path), content, mode, writeMode };
}

function generatedFiles(
  projectRoot: string,
  directory: string,
  files: Record<string, string>,
): GeneratedFile[] {
  return Object.entries(files).map(([name, content]) =>
    textFile(
      projectRoot,
      join(directory, name),
      content,
      content.startsWith("#!/") ? 0o755 : undefined,
    ),
  );
}

export function renderCommonArtifacts(plan: Plan, layout: RuntimeLayout): readonly GeneratedFile[] {
  const files: GeneratedFile[] = [
    textFile(
      layout.host.projectRoot,
      layout.host.dockerfile,
      generateDockerfile(plan, {
        generatedFilesPath: `.biodome-build/targets/${layout.host.targetName ?? ""}`,
      }),
    ),
    textFile(
      layout.host.projectRoot,
      join(layout.host.projectRoot, ".dockerignore"),
      generateDockerignore(),
      undefined,
      "if-absent",
    ),
    ...generatedFiles(
      layout.host.projectRoot,
      layout.host.healthchecks,
      generateHealthcheckScripts(plan),
    ),
    ...generatedFiles(layout.host.projectRoot, layout.host.repositories, generateRepoScripts(plan)),
    ...generatedFiles(
      layout.host.projectRoot,
      layout.host.services,
      generateInContainerServiceFiles(plan),
    ),
    ...generatedFiles(layout.host.projectRoot, layout.host.root, generateHarnessFiles(plan)),
    ...generatedFiles(layout.host.projectRoot, layout.host.root, generatePiHarnessFiles(plan)),
    ...generatedFiles(layout.host.projectRoot, layout.host.root, generateCodexHarnessFiles(plan)),
    ...generatedFiles(layout.host.projectRoot, layout.host.root, generateClaudeHarnessFiles(plan)),
  ];

  const supervisord = generateSupervisordConf(plan);
  if (supervisord)
    files.push(textFile(layout.host.projectRoot, layout.host.supervisordConfig, supervisord));

  const startup = generateStartupScript(plan);
  if (startup)
    files.push(textFile(layout.host.projectRoot, layout.host.startupScript, startup, 0o755));

  if (plan.build.mcpEnabled) {
    files.push(textFile(layout.host.projectRoot, layout.host.mcpPlan, generatePlanJson(plan)));
    const mcpSourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp");
    for (const runtimeFile of MCP_RUNTIME_FILES) {
      files.push({
        relativePath: relative(layout.host.projectRoot, join(layout.host.mcp, runtimeFile)),
        sourcePath: join(mcpSourceRoot, runtimeFile),
      });
    }
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

interface PathApi {
  readonly relative: typeof relative;
  readonly isAbsolute: typeof isAbsolute;
  readonly sep: string;
}

export function isPathWithin(
  outputRoot: string,
  outputPath: string,
  pathApi: PathApi = { relative, isAbsolute, sep },
): boolean {
  const pathFromRoot = pathApi.relative(outputRoot, outputPath);
  return (
    pathFromRoot === "" ||
    (!pathApi.isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${pathApi.sep}`))
  );
}

function validateGeneratedFile(file: GeneratedFile): void {
  if (!file.relativePath || isAbsolute(file.relativePath)) {
    throw new Error(`Artifact path must be a non-absolute relative path: ${file.relativePath}`);
  }
  if (file.relativePath.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error(`Artifact path must not contain traversal: ${file.relativePath}`);
  }
  if ((file.content === undefined) === (file.sourcePath === undefined)) {
    throw new Error(`Artifact ${file.relativePath} must have exactly one of content or sourcePath`);
  }
}

export function writeArtifacts(
  outputDir: string,
  files: readonly GeneratedFile[],
): Effect.Effect<readonly string[], RuntimeError> {
  return Effect.try({
    try: () => {
      const outputRoot = resolve(outputDir);
      return [...files]
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map((file) => {
          validateGeneratedFile(file);
          const outputPath = resolve(outputRoot, file.relativePath);
          if (!isPathWithin(outputRoot, outputPath)) {
            throw new Error(`Artifact path escapes output directory: ${file.relativePath}`);
          }
          if (file.writeMode === "if-absent" && existsSync(outputPath)) return undefined;
          mkdirSync(dirname(outputPath), { recursive: true });
          if (file.content !== undefined) {
            writeFileSync(outputPath, file.content);
          } else if (file.sourcePath !== undefined) {
            copyFileSync(file.sourcePath, outputPath);
          }
          if (file.mode !== undefined) chmodSync(outputPath, file.mode);
          return outputPath;
        })
        .filter((path): path is string => path !== undefined);
    },
    catch: (error) =>
      new RuntimeError({
        message: `Failed to write runtime artifacts: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
}
