import { BuildContext } from "./build-context.js";
import { LanguageOptions } from "./feature.js";

export function setupPython(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "3.12";
  ctx.setBaseImage(`python:${version}-slim`);

  if (options.packageManager === "poetry") {
    const files = ctx.requireDependencyFiles(["pyproject.toml", "poetry.lock"]);
    if (files.length > 0) {
      ctx.addDependencyInstall({
        files,
        command: `RUN pip install --no-cache-dir poetry && poetry config virtualenvs.in-project true && poetry install --no-root && poetry cache clear --all pypi && pip cache purge`,
      });
      ctx.addCopyArtifact({
        files: ["pyproject.toml"],
        lines: ["COPY --from=deps /workspace/.venv /workspace/.venv", "ENV PATH=/workspace/.venv/bin:$PATH"],
      });
      ctx.enableVenvVolume();
    }
  } else {
    const files = ctx.requireDependencyFiles(["requirements.txt"]);
    if (files.length > 0) {
      ctx.addDependencyInstall({
        files,
        command: `RUN python -m venv /workspace/.venv && /workspace/.venv/bin/pip install --no-cache-dir -r requirements.txt && pip cache purge`,
      });
      ctx.addCopyArtifact({
        files: ["requirements.txt"],
        lines: ["COPY --from=deps /workspace/.venv /workspace/.venv", "ENV PATH=/workspace/.venv/bin:$PATH"],
      });
      ctx.enableVenvVolume();
    }
  }
}

export function setupNode(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "20";
  ctx.setBaseImage(`node:${version}-slim`);

  if (options.packageManager === "pnpm") {
    ctx.addLanguageSnippet("RUN corepack enable && corepack prepare pnpm@latest --activate");
    const lockFile = "pnpm-lock.yaml";
    const files = ctx.requireDependencyFiles(["package.json", lockFile]);
    if (files.length > 0) {
      const flag = ctx.fileExists(lockFile) ? "--frozen-lockfile" : "";
      ctx.addDependencyInstall({
        files,
        command: `RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install ${flag} && mkdir -p /workspace/node_modules && pnpm store prune`.trimEnd(),
      });
      ctx.addCopyArtifact({
        files: ["package.json"],
        lines: ["COPY --from=deps /workspace/node_modules /workspace/node_modules"],
      });
    }
  } else if (options.packageManager === "yarn") {
    ctx.addLanguageSnippet("RUN corepack enable && corepack prepare yarn@stable --activate");
    const lockFile = "yarn.lock";
    const files = ctx.requireDependencyFiles(["package.json", lockFile]);
    if (files.length > 0) {
      const flag = ctx.fileExists(lockFile) ? "--frozen-lockfile" : "";
      ctx.addDependencyInstall({
        files,
        command: `RUN --mount=type=cache,target=/usr/local/share/.cache/yarn yarn install ${flag} && mkdir -p /workspace/node_modules && yarn cache clean`.trimEnd(),
      });
      ctx.addCopyArtifact({
        files: ["package.json"],
        lines: ["COPY --from=deps /workspace/node_modules /workspace/node_modules"],
      });
    }
  } else {
    const lockFile = "package-lock.json";
    const files = ctx.requireDependencyFiles(["package.json", lockFile]);
    if (files.length > 0) {
      const command = ctx.fileExists(lockFile)
        ? `RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline && mkdir -p /workspace/node_modules && npm cache clean --force`
        : `RUN --mount=type=cache,target=/root/.npm npm install && mkdir -p /workspace/node_modules && npm cache clean --force`;
      ctx.addDependencyInstall({
        files,
        command,
      });
      ctx.addCopyArtifact({
        files: ["package.json"],
        lines: ["COPY --from=deps /workspace/node_modules /workspace/node_modules"],
      });
    }
  }

  ctx.enableNodeModulesVolume();
}

export function setupGo(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "1.22";
  ctx.setBaseImage(`golang:${version}-alpine`);
  const files = ctx.requireDependencyFiles(["go.mod", "go.sum"]);
  if (files.length > 0) {
    ctx.addDependencyInstall({
      files,
      command: `RUN mkdir -p /workspace/go-mod && GOMODCACHE=/workspace/go-mod go mod download && go clean -cache`,
    });
    ctx.addCopyArtifact({
      files: ["go.mod"],
      lines: ["COPY --from=deps /workspace/go-mod /go/pkg/mod"],
    });
  }
}

export function setupRust(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "1.75";
  ctx.setBaseImage(`rust:${version}-slim`);
  const files = ctx.requireDependencyFiles(["Cargo.toml", "Cargo.lock"]);
  if (files.length > 0) {
    ctx.addDependencyInstall({
      files,
      command: `RUN cargo fetch && rm -rf /usr/local/cargo/registry/cache`,
    });
    ctx.addCopyArtifact({
      files: ["Cargo.toml"],
      lines: ["COPY --from=deps /usr/local/cargo/registry /usr/local/cargo/registry"],
    });
  }
}

export function setupJava(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "21";
  ctx.setBaseImage(`eclipse-temurin:${version}-jdk`);
}

export const languageHandlers: Record<string, (ctx: BuildContext, options: LanguageOptions) => void> = {
  python: setupPython,
  node: setupNode,
  go: setupGo,
  rust: setupRust,
  java: setupJava,
};
