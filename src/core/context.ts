import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  createPlan,
  Plan,
  Process,
  ProcessHealthCheck,
  Port,
  LifecyclePoint,
  Service,
} from "./plan.js";
import {
  FeatureContext,
  ProcessSpec,
  HookSpec,
  ProcessHealthCheckSpec,
  LanguageOptions,
  PackageOptions,
  ToolOptions,
  ServiceOptions,
} from "./feature.js";

export class SandboxContext implements FeatureContext {
  plan: Plan;
  private rootDir: string;

  constructor(rootDir: string, project: string) {
    this.rootDir = rootDir;
    this.plan = createPlan(project);
  }

  addProcess(spec: ProcessSpec): void {
    const proc = this.normalizeProcess(spec, "daemon", "start.post");
    this.plan.runtime.processes.push(proc);
    this.mergeProcessEnv(proc);
  }

  addHook(spec: HookSpec): void {
    if (!spec.startOn) {
      throw new Error(`Hook ${spec.name} requires a startOn lifecycle point`);
    }
    const proc = this.normalizeProcess(spec, "oneshot", spec.startOn);
    this.plan.runtime.processes.push(proc);
    this.mergeProcessEnv(proc);
  }

  addLanguage(name: string, options: LanguageOptions = {}): void {
    if (name === "python") {
      this.setupPython(options);
    } else if (name === "node") {
      this.setupNode(options);
    } else if (name === "go") {
      this.setupGo(options);
    } else if (name === "rust") {
      this.setupRust(options);
    } else if (name === "java") {
      this.setupJava(options);
    }
  }

  addPackage(manager: string, name: string, options: PackageOptions = {}): void {
    switch (manager) {
      case "npm":
        this.addLanguageSnippet(`RUN npm install -g ${formatPackage(name, options)}`);
        break;
      case "pip":
        this.addLanguageSnippet(`RUN pip install --no-cache-dir ${formatPackage(name, options, "==")}`);
        break;
      case "apt":
        this.addAptPackage(name);
        break;
      case "cargo":
        this.addLanguageSnippet(`RUN cargo install ${name}`);
        break;
      case "go":
        this.addLanguageSnippet(`RUN go install ${name}@latest`);
        break;
      case "gem":
        this.addLanguageSnippet(`RUN gem install ${name}`);
        break;
      default:
        throw new Error(`Unknown package manager ${manager}`);
    }
  }

  addAptPackage(name: string): void {
    if (!this.plan.build.aptPackages.includes(name)) {
      this.plan.build.aptPackages.push(name);
    }
  }

  addTool(name: string, _options: ToolOptions = {}): void {
    switch (name) {
      case "gh":
        this.addAptPackage("gh");
        this.addLanguageSnippet("RUN gh --version");
        break;
      case "kubectl":
        this.addLanguageSnippet(
          "RUN curl -fsSL https://dl.k8s.io/release/stable.txt > /tmp/kubectl-version && curl -fsSL https://dl.k8s.io/release/$(cat /tmp/kubectl-version)/bin/linux/amd64/kubectl -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl"
        );
        this.addLanguageSnippet("RUN kubectl version --client");
        break;
      case "terraform":
        this.addLanguageSnippet(
          "RUN curl -fsSL https://releases.hashicorp.com/terraform/1.7.0/terraform_1.7.0_linux_amd64.zip -o /tmp/terraform.zip && unzip -o /tmp/terraform.zip -d /usr/local/bin/"
        );
        this.addLanguageSnippet("RUN terraform -version");
        break;
      case "psql":
        this.addAptPackage("postgresql-client");
        this.addLanguageSnippet("RUN psql --version");
        break;
      case "redis-cli":
        this.addAptPackage("redis-tools");
        this.addLanguageSnippet("RUN redis-cli --version");
        break;
      case "docker":
        this.addAptPackage("docker.io");
        this.addLanguageSnippet("RUN docker --version");
        break;
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  addService(name: string, options: ServiceOptions = {}): void {
    let type = name;
    if (options.image) {
      // Custom image-based service; treat as a generic container.
      type = "container";
    }

    const svc: Service = {
      name,
      type,
      image: options.image || defaultImage(name),
      containerName: `${this.plan.project}-${name}`,
      environment: options.environment || {},
      ports: options.port ? [{ host: options.port, container: options.port }] : [],
      volumes: [],
      networks: ["sandbox"],
    };

    if (type === "postgres") {
      svc.environment.POSTGRES_USER = options.users?.[0]?.name || "postgres";
      svc.environment.POSTGRES_PASSWORD = options.users?.[0]?.password || "postgres";
      svc.environment.POSTGRES_DB = options.databases?.[0]?.name || "postgres";
      svc.volumes.push({ host: `${name}_data`, container: "/var/lib/postgresql/data" });
      svc.healthCheck = {
        test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"],
        interval: "5s",
        timeout: "3s",
        retries: 10,
      };
    } else if (type === "redis") {
      if (options.password) {
        svc.environment.REDIS_PASSWORD = options.password;
      }
      svc.volumes.push({ host: `${name}_data`, container: "/data" });
      const test = options.password
        ? `redis-cli ping | grep -q PONG`
        : "redis-cli ping | grep -q PONG";
      svc.healthCheck = {
        test: ["CMD-SHELL", test],
        interval: "5s",
        timeout: "3s",
        retries: 10,
      };
    }

    this.plan.runtime.services.push(svc);
    this.plan.runtime.volumes.push({ name: `${name}_data` });
  }

  setEnv(key: string, value: string): void {
    this.plan.build.environment[key] = value;
    this.plan.runtime.environment[key] = value;
  }

  fileExists(path: string): boolean {
    return existsSync(join(this.rootDir, path));
  }

  readFile(path: string): string {
    return readFileSync(join(this.rootDir, path), "utf-8");
  }

  readJSON(path: string): unknown {
    return JSON.parse(this.readFile(path));
  }

  exec(command: string): { stdout: string; stderr: string; exitCode: number } {
    console.log(`[exec] ${command}`);
    try {
      const stdout = execSync(command, {
        cwd: this.rootDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || "",
        exitCode: err.status || 1,
      };
    }
  }

  private normalizeProcess(
    spec: ProcessSpec,
    defaultMode: "daemon" | "oneshot",
    defaultStartOn: LifecyclePoint
  ): Process {
    const mode = spec.mode || defaultMode;
    const startOn = spec.startOn || defaultStartOn;

    const ports: Port[] = [];
    if (spec.port) {
      ports.push({ host: spec.port, container: spec.port });
    }
    if (spec.ports) {
      for (const p of Object.values(spec.ports)) {
        ports.push({ host: p, container: p });
      }
    }

    const healthCheck = spec.healthCheck
      ? this.normalizeHealthCheck(spec.healthCheck, spec.port)
      : undefined;

    return {
      name: spec.name,
      command: spec.command,
      ports,
      environment: spec.environment || {},
      workingDir: spec.workingDir,
      healthCheck,
      mode,
      startOn,
    };
  }

  private normalizeHealthCheck(
    spec: ProcessHealthCheckSpec,
    defaultPort?: number
  ): ProcessHealthCheck {
    const type = spec.type || "http";
    let url = spec.url;
    let port = spec.port;
    let command = spec.command;

    if (type === "http" && !url) {
      port = port || defaultPort;
      if (port) {
        url = `http://localhost:${port}`;
      }
    }

    if (type === "http") {
      this.addAptPackage("curl");
    }

    return {
      type,
      url,
      port,
      command,
      interval: spec.interval,
      timeout: spec.timeout,
      retries: spec.retries,
      startPeriod: spec.startPeriod,
    };
  }

  private mergeProcessEnv(proc: Process): void {
    for (const [key, value] of Object.entries(proc.environment)) {
      this.plan.runtime.environment[key] = value;
    }
  }

  private addLanguageSnippet(snippet: string): void {
    if (!this.plan.build.languageSnippets.includes(snippet)) {
      this.plan.build.languageSnippets.push(snippet);
    }
  }

  private setupPython(options: LanguageOptions): void {
    const version = options.version || "3.12";
    if (!this.plan.build.baseImage) {
      this.plan.build.baseImage = `python:${version}-slim`;
    }

    if (options.packageManager === "poetry") {
      this.plan.build.dependencyFiles.push("pyproject.toml", "poetry.lock");
      this.plan.build.dependencyInstalls.push({
        files: ["pyproject.toml", "poetry.lock"],
        command: `RUN pip install --no-cache-dir poetry && poetry config virtualenvs.in-project true && poetry install --no-root && poetry cache clear --all pypi && pip cache purge`,
      });
      this.plan.build.copyArtifacts.push({
        files: ["pyproject.toml"],
        lines: ["COPY --from=deps /workspace/.venv /workspace/.venv", "ENV PATH=/workspace/.venv/bin:$PATH"],
      });
    } else {
      this.plan.build.dependencyFiles.push("requirements.txt");
      this.plan.build.dependencyInstalls.push({
        files: ["requirements.txt"],
        command: `RUN python -m venv /workspace/.venv && /workspace/.venv/bin/pip install --no-cache-dir -r requirements.txt && pip cache purge`,
      });
      this.plan.build.copyArtifacts.push({
        files: ["requirements.txt"],
        lines: ["COPY --from=deps /workspace/.venv /workspace/.venv", "ENV PATH=/workspace/.venv/bin:$PATH"],
      });
    }
  }

  private setupNode(options: LanguageOptions): void {
    const version = options.version || "20";
    if (!this.plan.build.baseImage) {
      this.plan.build.baseImage = `node:${version}-slim`;
    }

    if (options.packageManager === "pnpm") {
      this.plan.build.languageSnippets.push("RUN corepack enable && corepack prepare pnpm@latest --activate");
      this.plan.build.dependencyFiles.push("package.json", "pnpm-lock.yaml");
      this.plan.build.dependencyInstalls.push({
        files: ["package.json", "pnpm-lock.yaml"],
        command: `RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile && pnpm store prune`,
      });
    } else if (options.packageManager === "yarn") {
      this.plan.build.languageSnippets.push("RUN corepack enable && corepack prepare yarn@stable --activate");
      this.plan.build.dependencyFiles.push("package.json", "yarn.lock");
      this.plan.build.dependencyInstalls.push({
        files: ["package.json", "yarn.lock"],
        command: `RUN --mount=type=cache,target=/usr/local/share/.cache/yarn yarn install --frozen-lockfile && yarn cache clean`,
      });
    } else {
      this.plan.build.dependencyFiles.push("package.json", "package-lock.json");
      this.plan.build.dependencyInstalls.push(
        {
          files: ["package-lock.json"],
          command: `RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline && npm cache clean --force`,
        },
        {
          files: ["package.json"],
          command: `RUN --mount=type=cache,target=/root/.npm npm install && npm cache clean --force`,
        }
      );
    }

    this.plan.build.copyArtifacts.push({
      files: ["package.json"],
      lines: ["COPY --from=deps /workspace/node_modules /workspace/node_modules"],
    });
    this.plan.build.nodeModulesVolume = true;
  }

  private setupGo(options: LanguageOptions): void {
    const version = options.version || "1.22";
    if (!this.plan.build.baseImage) {
      this.plan.build.baseImage = `golang:${version}-alpine`;
    }
    this.plan.build.dependencyFiles.push("go.mod", "go.sum");
    this.plan.build.dependencyInstalls.push({
      files: ["go.mod", "go.sum"],
      command: `RUN mkdir -p /workspace/go-mod && GOMODCACHE=/workspace/go-mod go mod download && go clean -cache`,
    });
    this.plan.build.copyArtifacts.push({
      files: ["go.mod"],
      lines: ["COPY --from=deps /workspace/go-mod /go/pkg/mod"],
    });
  }

  private setupRust(options: LanguageOptions): void {
    const version = options.version || "1.75";
    if (!this.plan.build.baseImage) {
      this.plan.build.baseImage = `rust:${version}-slim`;
    }
    this.plan.build.dependencyFiles.push("Cargo.toml", "Cargo.lock");
    this.plan.build.dependencyInstalls.push({
      files: ["Cargo.toml", "Cargo.lock"],
      command: `RUN cargo fetch && rm -rf /usr/local/cargo/registry/cache`,
    });
    this.plan.build.copyArtifacts.push({
      files: ["Cargo.toml"],
      lines: ["COPY --from=deps /usr/local/cargo/registry /usr/local/cargo/registry"],
    });
  }

  private setupJava(options: LanguageOptions): void {
    const version = options.version || "21";
    if (!this.plan.build.baseImage) {
      this.plan.build.baseImage = `eclipse-temurin:${version}-jdk`;
    }
  }
}

function formatPackage(name: string, options: PackageOptions, sep = "@"): string {
  return options.version ? `${name}${sep}${options.version}` : name;
}

function defaultImage(name: string): string {
  switch (name) {
    case "postgres":
      return "postgres:16-alpine";
    case "redis":
      return "redis:7-alpine";
    case "mysql":
      return "mysql:8";
    case "mongo":
      return "mongo:7";
    default:
      return name;
  }
}
