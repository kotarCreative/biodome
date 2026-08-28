import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

/** Generated plans/configs may embed infrastructure detail; keep them private. */
const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIR_MODE = 0o700;

export interface GeneratedFile {
  readonly relativePath: string;
  readonly content?: string;
  readonly sourcePath?: string;
  readonly mode?: number;
  readonly writeMode?: "overwrite" | "if-absent";
}

export const MCP_RUNTIME_FILES = [
  "core/redaction.js",
  "mcp/application.js",
  "mcp/auth.js",
  "mcp/command-runner.js",
  "mcp/event-sink.js",
  "mcp/plan.js",
  "mcp/provider-tools.js",
  "mcp/server.js",
  "mcp/startup.js",
  "mcp/tools/info-provider.js",
  "mcp/tools/process-logs.js",
  "mcp/tools/types.js",
  "mcp/tools/volumes.js",
  "mcp/upstream.js",
  "mcp/volumes/adapter.js",
  "mcp/volumes/azure.js",
  "mcp/volumes/gcs.js",
  "mcp/volumes/local.js",
  "mcp/volumes/s3.js",
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

  if (plan.deployment?.target.driver === "aws-ecs") {
    // A Dockerfile-specific ignore file takes precedence over a repository's
    // own .dockerignore, so upload workspaces cannot accidentally bake local
    // secrets or host dependency trees into the image.
    files.push(
      textFile(
        layout.host.projectRoot,
        `${layout.host.dockerfile}.dockerignore`,
        generateDockerignore(layout.host.targetName),
      ),
    );
  }

  const supervisord = generateSupervisordConf(plan);
  if (supervisord)
    files.push(textFile(layout.host.projectRoot, layout.host.supervisordConfig, supervisord));

  const startup = generateStartupScript(plan);
  if (startup)
    files.push(textFile(layout.host.projectRoot, layout.host.startupScript, startup, 0o755));

  if (plan.build.mcpEnabled) {
    files.push(textFile(layout.host.projectRoot, layout.host.mcpPlan, generatePlanJson(plan)));
    const runtimeSourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const runtimeFile of MCP_RUNTIME_FILES) {
      files.push({
        relativePath: relative(layout.host.projectRoot, join(layout.host.root, runtimeFile)),
        sourcePath: join(runtimeSourceRoot, runtimeFile),
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

/** True when the file on disk already holds exactly these bytes. */
function isByteIdentical(path: string, bytes: Uint8Array): boolean {
  try {
    const existing = readFileSync(path);
    return existing.equals(bytes);
  } catch {
    return false;
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
          // Skip byte-identical rewrites so mtimes stay stable and Docker
          // COPY layers keep caching; modes are still enforced.
          if (
            (file.content !== undefined &&
              existsSync(outputPath) &&
              isByteIdentical(outputPath, Buffer.from(file.content, "utf-8"))) ||
            (file.sourcePath !== undefined &&
              existsSync(outputPath) &&
              isByteIdentical(outputPath, readFileSync(file.sourcePath)))
          ) {
            chmodSync(outputPath, file.mode ?? DEFAULT_FILE_MODE);
            return undefined;
          }
          mkdirSync(dirname(outputPath), { recursive: true, mode: DEFAULT_DIR_MODE });
          if (file.content !== undefined) {
            writeFileSync(outputPath, file.content, { mode: DEFAULT_FILE_MODE });
          } else if (file.sourcePath !== undefined) {
            copyFileSync(file.sourcePath, outputPath);
          }
          chmodSync(outputPath, file.mode ?? DEFAULT_FILE_MODE);
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
