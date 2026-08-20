import type { BuildContext } from "./build-context.js";
import { ValidationError } from "./errors.js";
import type { ToolOptions } from "./feature.js";

type ToolHandler = (ctx: BuildContext, options: ToolOptions) => void;

export const AGENT_BROWSER_VERSION = "0.34.0";

function addAgentBrowser(ctx: BuildContext, options: ToolOptions): void {
  const version = options.version ?? AGENT_BROWSER_VERSION;
  if (version !== AGENT_BROWSER_VERSION) {
    throw new ValidationError({
      message: `agent-browser version ${version} is not supported; use ${AGENT_BROWSER_VERSION}`,
    });
  }

  ctx.addLanguageSnippet(
    [
      "RUN set -eux; \\",
      "    if command -v apt-get >/dev/null 2>&1; then \\",
      '      if [ -f /etc/os-release ] && grep -q "^ID=ubuntu$" /etc/os-release; then \\',
      '        echo "agent-browser requires a Debian-based image; Ubuntu-based images such as eclipse-temurin provide no installable chromium package" >&2; exit 1; \\',
      "      fi; \\",
      "      apt-get update; \\",
      "      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates chromium curl ffmpeg fonts-liberation fonts-noto-cjk fonts-noto-color-emoji fonts-noto-core xvfb; \\",
      "      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \\",
      '      libc="gnu"; \\',
      "    elif command -v apk >/dev/null 2>&1; then \\",
      "      apk add --no-cache ca-certificates chromium curl ffmpeg font-noto font-noto-cjk font-noto-emoji xvfb-run; \\",
      '      libc="musl"; \\',
      "    else \\",
      '      echo "agent-browser requires an apt- or apk-based image" >&2; exit 1; \\',
      "    fi; \\",
      '    arch="$(uname -m)"; \\',
      '    case "$libc-$arch" in \\',
      '      gnu-x86_64) asset="agent-browser-linux-x64"; checksum="69eadf5d8d6003a06a5cd2f914ebb261c7754fe1335a9190122c334e91909789" ;; \\',
      '      gnu-aarch64|gnu-arm64) asset="agent-browser-linux-arm64"; checksum="ca70bf7c2d269a152b3824cbb65befb7b8258b8aa1cf34767c64ada2abc3d7c8" ;; \\',
      '      musl-x86_64) asset="agent-browser-linux-musl-x64"; checksum="dd4752ba1def81c7443504c284b6559d28dad8ecd02b5faeca6caf4fc1fb948e" ;; \\',
      '      musl-aarch64|musl-arm64) asset="agent-browser-linux-musl-arm64"; checksum="c0864fb206e321af48a46fb8331cf08ae60b3fcc1046232c1d1c842db4fc40ca" ;; \\',
      '      *) echo "Unsupported platform for agent-browser: $libc-$arch" >&2; exit 1 ;; \\',
      "    esac; \\",
      `    curl -fsSL --retry 3 "https://github.com/vercel-labs/agent-browser/releases/download/v${version}/$asset" -o /tmp/agent-browser; \\`,
      '    echo "$checksum  /tmp/agent-browser" | sha256sum -c -; \\',
      "    install -m 0755 /tmp/agent-browser /usr/local/bin/agent-browser; \\",
      "    rm /tmp/agent-browser; \\",
      '    browser="$(command -v chromium || command -v chromium-browser)"; \\',
      '    ln -sf "$browser" /usr/local/bin/biodome-chromium',
    ].join("\n"),
  );
  ctx.addLanguageSnippet("RUN agent-browser --version");
}

export const toolHandlers: Record<string, ToolHandler> = {
  gh: (ctx) => {
    ctx.addAptPackage("gh");
    ctx.addLanguageSnippet("RUN gh --version");
  },
  kubectl: (ctx) => {
    ctx.addLanguageSnippet(
      "RUN curl -fsSL https://dl.k8s.io/release/stable.txt > /tmp/kubectl-version && curl -fsSL https://dl.k8s.io/release/$(cat /tmp/kubectl-version)/bin/linux/amd64/kubectl -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl",
    );
    ctx.addLanguageSnippet("RUN kubectl version --client");
  },
  terraform: (ctx) => {
    ctx.addLanguageSnippet(
      "RUN curl -fsSL https://releases.hashicorp.com/terraform/1.7.0/terraform_1.7.0_linux_amd64.zip -o /tmp/terraform.zip && unzip -o /tmp/terraform.zip -d /usr/local/bin/",
    );
    ctx.addLanguageSnippet("RUN terraform -version");
  },
  psql: (ctx) => {
    ctx.addAptPackage("postgresql-client");
    ctx.addLanguageSnippet("RUN psql --version");
  },
  "redis-cli": (ctx) => {
    ctx.addAptPackage("redis-tools");
    ctx.addLanguageSnippet("RUN redis-cli --version");
  },
  docker: (ctx) => {
    ctx.addAptPackage("docker.io");
    ctx.addLanguageSnippet("RUN docker --version");
  },
  "agent-browser": addAgentBrowser,
};
