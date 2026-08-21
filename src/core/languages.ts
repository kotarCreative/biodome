import { BuildContext } from "./build-context.js";
import { LanguageOptions } from "./feature.js";

const DEFAULT_BASE_IMAGE = "debian:12-slim";

export interface LanguageHandler {
  baseImage(options: LanguageOptions): string;
  installRuntime(ctx: BuildContext, options: LanguageOptions): void;
  installDependencies(ctx: BuildContext, options: LanguageOptions): void;
}

function aptCacheMounts(): string {
  return [
    "--mount=type=cache,target=/var/cache/apt,sharing=locked",
    "--mount=type=cache,target=/var/lib/apt/lists,sharing=locked",
  ].join(" ");
}

function aptInstall(packages: string[]): string {
  return `apt-get update && apt-get install -y --no-install-recommends ${packages.join(" ")}`;
}

function shell(lines: string[]): string {
  return "RUN " + lines.join(" ");
}

// Python
// -----
// In single-language mode we use the official python slim image.
// In multi-language mode we install Python via pyenv on the neutral base.
// Pyenv can resolve `3.12` to the latest patch release, so users may pass
// either a major.minor or major.minor.patch version.

function pythonBaseImage(options: LanguageOptions): string {
  const version = options.version || "3.12";
  return `python:${version}-slim`;
}

function pythonRuntimeInstall(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "3.12";
  const buildDeps = [
    "ca-certificates",
    "curl",
    "git",
    "make",
    "build-essential",
    "libssl-dev",
    "zlib1g-dev",
    "libbz2-dev",
    "libreadline-dev",
    "libsqlite3-dev",
    "libncursesw5-dev",
    "libncurses5-dev",
    "libffi-dev",
    "liblzma-dev",
  ];
  // PYENV_ROOT lives outside /root so every runtime identity (not just the
  // build-time root user) can execute the installed interpreter and shims.
  ctx.addRuntimeInstall(
    shell([
      aptCacheMounts(),
      aptInstall(buildDeps),
      "&& export PYENV_ROOT=/opt/pyenv",
      "&& curl -fsSL https://pyenv.run | bash",
      '&& export PATH="$PYENV_ROOT/bin:$PATH"',
      `&& pyenv install -s ${version}`,
      `&& pyenv global ${version}`,
      '&& ln -sf "$PYENV_ROOT/shims/python" /usr/local/bin/python',
      '&& ln -sf "$PYENV_ROOT/shims/python3" /usr/local/bin/python3',
      '&& ln -sf "$PYENV_ROOT/shims/pip" /usr/local/bin/pip',
      '&& ln -sf "$PYENV_ROOT/shims/pip3" /usr/local/bin/pip3',
    ]),
  );
}

function pythonDependencies(ctx: BuildContext, options: LanguageOptions): void {
  if (options.packageManager === "poetry") {
    const files = ctx.requireDependencyFiles(["pyproject.toml", "poetry.lock"]);
    if (files.length > 0) {
      ctx.addDependencyInstall({
        files,
        command: `RUN pip install --no-cache-dir poetry && poetry config virtualenvs.in-project true && poetry install --no-root && poetry cache clear --all pypi && pip cache purge`,
      });
      ctx.addCopyArtifact({
        files: ["pyproject.toml"],
        lines: [
          "COPY --from=deps /workspace/.venv /workspace/.venv",
          "ENV PATH=/workspace/.venv/bin:$PATH",
        ],
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
        lines: [
          "COPY --from=deps /workspace/.venv /workspace/.venv",
          "ENV PATH=/workspace/.venv/bin:$PATH",
        ],
      });
      ctx.enableVenvVolume();
    }
  }
}

// Node
// ----
// In single-language mode we use the official node slim image.
// In multi-language mode we install Node via NodeSource.

function nodeBaseImage(options: LanguageOptions): string {
  const version = options.version || "20";
  return `node:${version}-slim`;
}

function nodeRuntimeInstall(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "20";
  ctx.addRuntimeInstall(
    shell([
      aptCacheMounts(),
      aptInstall(["ca-certificates", "curl", "gnupg"]),
      "&& mkdir -p /etc/apt/keyrings",
      "&& curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg",
      `&& echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${version}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list`,
      "&& apt-get update",
      "&& apt-get install -y --no-install-recommends nodejs",
    ]),
  );
}

function nodeDependencies(ctx: BuildContext, options: LanguageOptions): void {
  if (options.packageManager === "pnpm") {
    // Use pnpm 10.x — pnpm 11 moved to pnpm-workspace.yaml for settings and
    // removed neverBuiltDependencies. Pin to v10 so we can inject the config
    // via .npmrc until proper pnpm 11 support is added.
    ctx.addLanguageSnippet("RUN corepack enable && corepack prepare pnpm@10 --activate");
    const lockFile = "pnpm-lock.yaml";
    const files = ctx.requireDependencyFiles(["package.json", lockFile]);
    if (files.length > 0) {
      const flag = ctx.fileExists(lockFile) ? "--frozen-lockfile" : "";
      // pnpm 10 blocks lifecycle scripts by default. Inject an empty
      // neverBuiltDependencies allowlist so all build scripts run (expected
      // in dev environments).
      ctx.addDependencyInstall({
        files,
        command:
          `RUN --mount=type=cache,target=/root/.local/share/pnpm/store echo 'neverBuiltDependencies=' > .npmrc && pnpm install ${flag} && mkdir -p /workspace/node_modules && pnpm store prune`.trimEnd(),
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
        command:
          `RUN --mount=type=cache,target=/usr/local/share/.cache/yarn yarn install ${flag} && mkdir -p /workspace/node_modules && yarn cache clean`.trimEnd(),
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

// Go
// --
// In single-language mode we use the official golang alpine image.
// In multi-language mode we download the official tarball on the neutral base.

function goBaseImage(options: LanguageOptions): string {
  const version = options.version || "1.22";
  return `golang:${version}-alpine`;
}

function normalizeGoVersion(version: string): string {
  // The Go download URL requires a full semver tag. Accept `1.22` and expand
  // it to `1.22.0` so users do not have to remember the patch version.
  if (/^\d+\.\d+$/.test(version)) {
    return `${version}.0`;
  }
  return version;
}

function goRuntimeInstall(ctx: BuildContext, options: LanguageOptions): void {
  const version = normalizeGoVersion(options.version || "1.22");
  ctx.addRuntimeInstall(
    shell([
      aptCacheMounts(),
      aptInstall(["ca-certificates", "curl"]),
      "&& ARCH=$(dpkg --print-architecture)",
      `&& curl -fsSL https://go.dev/dl/go${version}.linux-\${ARCH}.tar.gz | tar -C /usr/local -xz`,
      "&& ln -sf /usr/local/go/bin/go /usr/local/bin/go",
      "&& ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt",
    ]),
  );
  // Match the module cache path used by goDependencies so dependencies are
  // found at runtime in multi-language mode.
  ctx.addLanguageSnippet("ENV GOPATH=/go");
}

function goDependencies(ctx: BuildContext, _options: LanguageOptions): void {
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

// Rust
// ----
// In single-language mode we use the official rust slim image.
// In multi-language mode we install rustup on the neutral base.

function rustBaseImage(options: LanguageOptions): string {
  const version = options.version || "1.75";
  return `rust:${version}-slim`;
}

function rustRuntimeInstall(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "1.75";
  // RUSTUP_HOME/CARGO_HOME live outside /root so every runtime identity (not
  // just the build-time root user) can execute the toolchain.
  ctx.addRuntimeInstall(
    shell([
      aptCacheMounts(),
      aptInstall(["ca-certificates", "curl", "build-essential"]),
      "&& export RUSTUP_HOME=/usr/local/rustup",
      "&& export CARGO_HOME=/usr/local/cargo",
      `&& curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain ${version} --profile minimal`,
      "&& ln -sf /usr/local/cargo/bin/rustc /usr/local/bin/rustc",
      "&& ln -sf /usr/local/cargo/bin/cargo /usr/local/bin/cargo",
    ]),
  );
  // Match the toolchain paths used by rustDependencies so they are found at
  // runtime in multi-language mode.
  ctx.addLanguageSnippet("ENV RUSTUP_HOME=/usr/local/rustup");
  ctx.addLanguageSnippet("ENV CARGO_HOME=/usr/local/cargo");
}

function rustDependencies(ctx: BuildContext, _options: LanguageOptions): void {
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

// Java
// ----
// In single-language mode we use the Eclipse Temurin JDK image.
// In multi-language mode we install Temurin via the Adoptium apt repository.

function javaBaseImage(options: LanguageOptions): string {
  const version = options.version || "21";
  return `eclipse-temurin:${version}-jdk`;
}

function javaRuntimeInstall(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "21";
  ctx.addRuntimeInstall(
    shell([
      aptCacheMounts(),
      aptInstall(["ca-certificates", "curl", "gnupg", "wget"]),
      "&& mkdir -p /etc/apt/keyrings",
      "&& curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg",
      "&& echo \"deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(awk -F= '/^VERSION_CODENAME/{print$2}' /etc/os-release) main\" | tee /etc/apt/sources.list.d/adoptium.list",
      "&& apt-get update",
      `&& apt-get install -y --no-install-recommends temurin-${version}-jdk`,
    ]),
  );
}

function javaDependencies(_ctx: BuildContext, _options: LanguageOptions): void {
  // Maven and Gradle dependency handling are not implemented yet.
}

// PHP
// ---
// In single-language mode we use the official PHP CLI image.
// In multi-language mode we install PHP from the Sury repository on the
// neutral Debian base. Composer is always installed so that `biodome exec
// composer` works, and Laravel projects are supported through the standard
// composer.json workflow.

function phpBaseImage(options: LanguageOptions): string {
  const version = options.version || "8.3";
  return `php:${version}-cli`;
}

function phpRuntimeInstall(ctx: BuildContext, options: LanguageOptions): void {
  const version = options.version || "8.3";
  const majorMinor = version.split(".").slice(0, 2).join(".");
  ctx.addRuntimeInstall(
    shell([
      aptCacheMounts(),
      aptInstall(["ca-certificates", "curl", "gnupg", "lsb-release"]),
      "&& mkdir -p /etc/apt/keyrings",
      "&& curl -fsSL https://packages.sury.org/php/apt.gpg | gpg --dearmor -o /etc/apt/keyrings/sury-php.gpg",
      '&& echo "deb [signed-by=/etc/apt/keyrings/sury-php.gpg] https://packages.sury.org/php/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/sury-php.list',
      "&& apt-get update",
      `&& apt-get install -y --no-install-recommends php${majorMinor}-cli php${majorMinor}-common php${majorMinor}-curl php${majorMinor}-mbstring php${majorMinor}-xml php${majorMinor}-zip php${majorMinor}-mysql php${majorMinor}-pgsql php${majorMinor}-sqlite3 php${majorMinor}-intl php${majorMinor}-bcmath php${majorMinor}-gd`,
    ]),
  );
  ctx.addLanguageSnippet(
    "RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer",
  );
}

function phpDependencies(ctx: BuildContext, _options: LanguageOptions): void {
  ctx.addLanguageSnippet(
    "RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer",
  );
  const files = ctx.requireDependencyFiles(["composer.json", "composer.lock"]);
  if (files.length > 0) {
    ctx.addDependencyInstall({
      files,
      command:
        "RUN --mount=type=cache,target=/root/.composer/cache composer install --no-interaction --no-progress --optimize-autoloader && rm -rf /root/.composer/cache/*",
    });
    ctx.addCopyArtifact({
      files: ["composer.json"],
      lines: ["COPY --from=deps /workspace/vendor /workspace/vendor"],
    });
    ctx.enableVendorVolume();
  }
}

export const languageHandlers: Record<string, LanguageHandler> = {
  python: {
    baseImage: pythonBaseImage,
    installRuntime: pythonRuntimeInstall,
    installDependencies: pythonDependencies,
  },
  node: {
    baseImage: nodeBaseImage,
    installRuntime: nodeRuntimeInstall,
    installDependencies: nodeDependencies,
  },
  go: {
    baseImage: goBaseImage,
    installRuntime: goRuntimeInstall,
    installDependencies: goDependencies,
  },
  rust: {
    baseImage: rustBaseImage,
    installRuntime: rustRuntimeInstall,
    installDependencies: rustDependencies,
  },
  java: {
    baseImage: javaBaseImage,
    installRuntime: javaRuntimeInstall,
    installDependencies: javaDependencies,
  },
  php: {
    baseImage: phpBaseImage,
    installRuntime: phpRuntimeInstall,
    installDependencies: phpDependencies,
  },
};

export function getDefaultBaseImage(): string {
  return DEFAULT_BASE_IMAGE;
}
