import { existsSync, readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { Schema } from "effect"
import {
  createPlan,
  Plan,
  Process,
  ProcessHealthCheck,
  Port,
  LifecyclePoint,
  Service,
  DependencyInstall,
  CopyArtifact,
  ProcessSpecSchema,
  HookSpecSchema,
  ServiceOptionsSchema,
  ProcessHealthCheckSpecSchema,
} from "./plan.js"
import {
  FeatureContext,
  ProcessSpec,
  HookSpec,
  LanguageOptions,
  PackageOptions,
  ToolOptions,
  ServiceOptions,
} from "./feature.js"
import { BuildContext } from "./build-context.js"
import { languageHandlers, getDefaultBaseImage } from "./languages.js"
import { formatPackage } from "./packages.js"
import { serviceConfigs, defaultImage } from "./services.js"
import { toolHandlers } from "./tools.js"
import { ValidationError } from "./errors.js"

function validatePort(value: unknown, label: string): void {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ValidationError({ message: `${label} must be an integer between 1 and 65535` })
  }
}

function validateEnv(env: Record<string, unknown>, label: string): asserts env is Record<string, string> {
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new ValidationError({ message: `${label} must be a record of strings` })
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new ValidationError({ message: `${label}.${key} must be a string` })
    }
  }
}

export class SandboxContext implements FeatureContext, BuildContext {
  plan: Plan
  private rootDir: string
  private dryRun: boolean

  constructor(rootDir: string, project: string, dryRun = false) {
    this.rootDir = rootDir
    this.dryRun = dryRun
    this.plan = createPlan(project)
  }

  addProcess(spec: ProcessSpec): void {
    const validated = Schema.decodeSync(ProcessSpecSchema)(spec)
    if (validated.port !== undefined) validatePort(validated.port, `Process ${validated.name}: port`)
    if (validated.ports) {
      for (const [portName, port] of Object.entries(validated.ports)) {
        validatePort(port, `Process ${validated.name}: ports.${portName}`)
      }
    }
    if (validated.environment) {
      validateEnv(validated.environment as Record<string, unknown>, `Process ${validated.name}: environment`)
    }

    this.assertUniqueProcessName(validated.name)
    const proc = this.normalizeProcess(validated, "daemon", "start.post")
    this.plan.runtime.processes.push(proc)
    this.mergeProcessEnv(proc)
  }

  addHook(spec: HookSpec): void {
    const validated = Schema.decodeSync(HookSpecSchema)(spec)
    if (validated.port !== undefined) validatePort(validated.port, `Hook ${validated.name}: port`)
    if (validated.ports) {
      for (const [portName, port] of Object.entries(validated.ports)) {
        validatePort(port, `Hook ${validated.name}: ports.${portName}`)
      }
    }
    if (validated.environment) {
      validateEnv(validated.environment as Record<string, unknown>, `Hook ${validated.name}: environment`)
    }

    this.assertUniqueProcessName(validated.name)
    const proc = this.normalizeProcess(validated, "oneshot", validated.startOn as LifecyclePoint)
    this.plan.runtime.processes.push(proc)
    this.mergeProcessEnv(proc)
  }

  private assertUniqueProcessName(name: string): void {
    if (this.plan.runtime.processes.some((p) => p.name === name)) {
      throw new ValidationError({ message: `Duplicate process or hook name: ${name}` })
    }
  }

  addLanguage(name: string, options: LanguageOptions = {}): void {
    if (!languageHandlers[name]) {
      return
    }
    const existing = this.plan.build.languageRequests.findIndex((r) => r.name === name)
    if (existing >= 0) {
      this.plan.build.languageRequests[existing] = { name, options }
    } else {
      this.plan.build.languageRequests.push({ name, options })
    }
  }

  finalizeBuildPlan(): void {
    const requests = this.plan.build.languageRequests

    if (requests.length === 0) {
      this.setBaseImage(getDefaultBaseImage())
      return
    }

    if (requests.length === 1) {
      const { name, options } = requests[0]
      const handler = languageHandlers[name]
      if (handler) {
        this.setBaseImage(handler.baseImage(options))
        handler.installDependencies(this, options)
      }
      return
    }

    // Multiple languages: use the neutral base image and install every runtime.
    this.setBaseImage(getDefaultBaseImage())
    for (const { name, options } of requests) {
      const handler = languageHandlers[name]
      if (!handler) continue
      handler.installRuntime(this, options)
      handler.installDependencies(this, options)
    }
  }

  addPackage(manager: string, name: string, options: PackageOptions = {}): void {
    if (!name || typeof name !== "string") {
      throw new ValidationError({ message: "Package requires a non-empty string name" })
    }
    const registryFlag = options.indexUrl ? ` --registry ${options.indexUrl}` : ""
    const indexUrlFlag = options.indexUrl ? ` --index-url ${options.indexUrl}` : ""

    const commands: Record<string, string> = {
      npm: `npm install -g${registryFlag} ${formatPackage(name, options)}`,
      pip: `pip install --no-cache-dir${indexUrlFlag} ${formatPackage(name, options, "==")}`,
      cargo: `cargo install ${name}`,
      go: `go install ${name}@latest`,
      gem: `gem install ${name}`,
    }

    const command = commands[manager]
    if (!command) {
      throw new ValidationError({ message: `Unknown package manager ${manager}` })
    }
    this.addLanguageSnippet(`RUN ${command}`)
  }

  addTool(name: string, _options: ToolOptions = {}): void {
    if (!name || typeof name !== "string") {
      throw new ValidationError({ message: "Tool requires a non-empty string name" })
    }
    const handler = toolHandlers[name]
    if (handler) {
      handler(this)
    } else {
      // Unknown tools are treated as apt packages.
      this.addAptPackage(name)
    }
  }

  addAptPackage(name: string): void {
    if (!this.plan.build.aptPackages.includes(name)) {
      this.plan.build.aptPackages.push(name)
    }
  }

  addService(name: string, options: ServiceOptions = {}): void {
    if (!name || typeof name !== "string") {
      throw new ValidationError({ message: "Service requires a non-empty string name" })
    }
    const validated = Schema.decodeSync(ServiceOptionsSchema)(options)
    validatePort(validated.port, `Service ${name}: port`)
    if (validated.environment) {
      validateEnv(validated.environment as Record<string, unknown>, `Service ${name}: environment`)
    }

    if (this.plan.runtime.services.some((s) => s.name === name)) {
      throw new ValidationError({ message: `Duplicate service name: ${name}` })
    }

    let type = name
    if (validated.image) {
      // Custom image-based service; treat as a generic container.
      type = "container"
    }

    const svc: Service = {
      name,
      type,
      image: validated.image || defaultImage(name),
      containerName: `${this.plan.project}-${name}`,
      environment: validated.environment || {},
      ports: validated.port ? [{ host: validated.port, container: validated.port }] : [],
      volumes: [],
      networks: ["biodome"],
    }

    const config = serviceConfigs[type]
    if (config) {
      config(svc, validated)
    }

    this.plan.runtime.services.push(svc)
    for (const vol of svc.volumes) {
      if (!vol.host.startsWith("/") && !vol.host.startsWith("./") && !vol.host.startsWith("~")) {
        this.plan.runtime.volumes.push({ name: vol.host })
      }
    }
  }

  setEnv(key: string, value: string): void {
    this.plan.build.environment[key] = value
    this.plan.runtime.environment[key] = value
  }

  fileExists(path: string): boolean {
    return existsSync(join(this.rootDir, path))
  }

  readFile(path: string): string {
    return readFileSync(join(this.rootDir, path), "utf-8")
  }

  readJSON(path: string): unknown {
    return JSON.parse(this.readFile(path))
  }

  exec(command: string): { stdout: string; stderr: string; exitCode: number } {
    if (this.dryRun) {
      console.log(`[exec] (dry run) ${command}`)
      return { stdout: "", stderr: "", exitCode: 0 }
    }

    console.log(`[exec] ${command}`)
    try {
      const stdout = execSync(command, {
        cwd: this.rootDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      return { stdout, stderr: "", exitCode: 0 }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string; status?: number }
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || "",
        exitCode: err.status || 1,
      }
    }
  }

  // BuildContext helpers — encapsulate plan mutations.

  setBaseImage(name: string): boolean {
    if (this.plan.build.baseImage) {
      return false
    }
    this.plan.build.baseImage = name
    return true
  }

  requireDependencyFiles(files: string[]): string[] {
    const existing: string[] = []
    for (const file of files) {
      if (this.fileExists(file)) {
        existing.push(file)
        if (!this.plan.build.dependencyFiles.includes(file)) {
          this.plan.build.dependencyFiles.push(file)
        }
      }
    }
    return existing
  }

  addDependencyInstall(install: DependencyInstall): void {
    this.plan.build.dependencyInstalls.push(install)
  }

  addCopyArtifact(artifact: CopyArtifact): void {
    this.plan.build.copyArtifacts.push(artifact)
  }

  private normalizeProcess(
    spec: ProcessSpec,
    defaultMode: "daemon" | "oneshot",
    defaultStartOn: LifecyclePoint
  ): Process {
    const mode = spec.mode || defaultMode
    const startOn = spec.startOn || defaultStartOn

    const ports: Port[] = []
    if (spec.port) {
      ports.push({ host: spec.port, container: spec.port })
    }
    if (spec.ports) {
      for (const [portName, p] of Object.entries(spec.ports)) {
        ports.push({ name: portName, host: p, container: p })
      }
    }

    const healthCheck = spec.healthCheck
      ? this.normalizeHealthCheck(spec.healthCheck, spec.port)
      : undefined

    return {
      name: spec.name,
      command: [...spec.command],
      ports,
      environment: spec.environment ? { ...spec.environment } : {},
      workingDir: this.normalizeWorkingDir(spec.workingDir),
      healthCheck,
      mode,
      startOn,
    }
  }

  private normalizeWorkingDir(workingDir: string | undefined): string | undefined {
    if (!workingDir) return undefined
    if (workingDir.startsWith("/")) return workingDir
    return `/workspace/${workingDir}`
  }

  private normalizeHealthCheck(
    spec: typeof ProcessHealthCheckSpecSchema.Type,
    defaultPort?: number
  ): ProcessHealthCheck {
    const type = spec.type || "http"
    let url = spec.url
    let port = spec.port
    const command = spec.command ? [...spec.command] : undefined

    if (type === "http" && !url) {
      port = port || defaultPort
      if (port) {
        url = `http://localhost:${port}`
      }
    }

    if (type === "http") {
      this.addAptPackage("curl")
    }

    if (type === "tcp") {
      this.addAptPackage("netcat-openbsd")
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
    }
  }

  private mergeProcessEnv(proc: Process): void {
    for (const [key, value] of Object.entries(proc.environment)) {
      this.plan.runtime.environment[key] = value
    }
  }

  addRuntimeInstall(snippet: string): void {
    if (!this.plan.build.runtimeInstalls.includes(snippet)) {
      this.plan.build.runtimeInstalls.push(snippet)
    }
  }

  addLanguageSnippet(snippet: string): void {
    if (!this.plan.build.languageSnippets.includes(snippet)) {
      this.plan.build.languageSnippets.push(snippet)
    }
  }

  enableNodeModulesVolume(): void {
    this.plan.build.nodeModulesVolume = true
  }

  enableVenvVolume(): void {
    this.plan.build.venvVolume = true
  }
}
