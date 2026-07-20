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
  EndpointSpecSchema,
  EnvSpecSchema,
  EnvVar,
  ProcessHealthCheckSpecSchema,
  VolumeSpecSchema,
  Volume,
  SecretValue,
} from "./plan.js"
import {
  FeatureContext,
  ProcessSpec,
  HookSpec,
  LanguageOptions,
  PackageOptions,
  ToolOptions,
  ServiceOptions,
  EndpointSpec,
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

// POSIX-ish env var name: letters, digits, underscore; not starting with a digit.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function validateEnvKey(key: string, label: string): void {
  if (typeof key !== "string" || !ENV_KEY_PATTERN.test(key)) {
    throw new ValidationError({
      message: `${label} must match ${ENV_KEY_PATTERN.source}`,
    })
  }
}

// Docker Compose interpolation ${VAR:-default} cannot contain characters that
// terminate or alter the interpolation (}:, :, ?, ${) or control characters.
const SAFE_INTERPOLATION_DEFAULT = /^[^:${}?\x00-\x1f\x7f]+$/

function validateInterpolationDefault(value: string | undefined, label: string): void {
  if (value === undefined) return
  if (!SAFE_INTERPOLATION_DEFAULT.test(value)) {
    throw new ValidationError({
      message: `${label} contains characters that are not safe inside a Docker Compose interpolation default`,
    })
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
        this.plan.runtime.namedVolumes.push({ name: vol.host })
      }
    }
  }

  addEndpoint(spec: EndpointSpec): void {
    const validated = Schema.decodeSync(EndpointSpecSchema)(spec)
    if (validated.port !== undefined) validatePort(validated.port, `Endpoint ${validated.name}: port`)
    if (validated.metadata) {
      validateEnv(validated.metadata as Record<string, unknown>, `Endpoint ${validated.name}: metadata`)
    }

    if (this.plan.runtime.endpoints.some((e) => e.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate endpoint name: ${validated.name}` })
    }

    this.plan.runtime.endpoints.push({
      name: validated.name,
      description: validated.description,
      url: validated.url,
      port: validated.port,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
      metadata: validated.metadata ? { ...validated.metadata } : undefined,
    })
  }

  addEnv(key: string, spec: EnvSpec): void {
    validateEnvKey(key, `Env ${key}: key`)
    const validated = Schema.decodeSync(EnvSpecSchema)(spec)

    const hasValue = validated.value !== undefined
    const hasFrom = validated.from !== undefined
    if (hasValue === hasFrom) {
      throw new ValidationError({
        message: `Env ${key}: provide exactly one of 'value' (literal) or 'from' (host passthrough)`,
      })
    }
    if (hasFrom && validated.scope === "build") {
      throw new ValidationError({
        message: `Env ${key}: passthrough ('from') variables cannot be build-scoped because Docker builds cannot read the host environment. Use scope "runtime" or "both".`,
      })
    }
    if (hasValue && (validated.required || validated.default !== undefined)) {
      throw new ValidationError({
        message: `Env ${key}: 'required' and 'default' only apply to passthrough ('from') variables`,
      })
    }
    validateInterpolationDefault(validated.default, `Env ${key}: default`)

    if (this.plan.runtime.envVars.some((e) => e.key === key)) {
      throw new ValidationError({ message: `Duplicate env variable: ${key}` })
    }

    const scope = validated.scope || "runtime"
    const envVar: EnvVar = hasValue
      ? { key, scope, value: validated.value }
      : {
          key,
          scope,
          from: { env: validated.from!.env },
          required: validated.required,
          default: validated.default,
        }
    this.plan.runtime.envVars.push(envVar)

    // Literal values are mirrored into the flat environment maps so they flow
    // into the Dockerfile ENV layer / compose exactly as before. Passthrough
    // references are deliberately NOT written here — they never touch the image
    // or plan.json and are resolved from the host at `up` time.
    if (hasValue) {
      if (scope === "build" || scope === "both") {
        this.plan.build.environment[key] = validated.value!
      }
      if (scope === "runtime" || scope === "both") {
        this.plan.runtime.environment[key] = validated.value!
      }
    }
  }

  addVolume(spec: VolumeSpec): void {
    const validated = Schema.decodeSync(VolumeSpecSchema)(spec)

    if (this.plan.runtime.volumes.some((v) => v.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate volume name: ${validated.name}` })
    }

    this.validateVolumeSpec(validated)

    const volume: Volume = {
      name: validated.name,
      type: validated.type,
      source: validated.source,
      target: validated.target,
      bucket: validated.bucket,
      prefix: validated.prefix,
      path: validated.path,
      endpoint: validated.endpoint,
      account: validated.account,
      container: validated.container,
      host: validated.host,
      port: validated.port,
      export: validated.export,
      share: validated.share,
      url: validated.url,
      vendor: validated.vendor,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
      options: validated.options ? { ...validated.options } : undefined,
    }

    this.plan.runtime.volumes.push(volume)

    if (validated.type === "local") {
      // Local bind mounts are emitted directly in compose; nothing else to do.
      return
    }

    // Cloud-backed volumes use rclone. Ensure it and FUSE are available.
    this.addAptPackage("rclone")
    this.addAptPackage("fuse3")

    const env = this.buildRcloneEnv(volume)

    // Bucket/folder mounts run as a daemon process.
    const remote = this.rcloneRemote(volume)
    const command = [
      "rclone",
      "mount",
      remote,
      validated.target,
      "--allow-other",
      "--vfs-cache-mode",
      "writes",
    ]
    if (validated.options?.readOnly === "true") {
      command.push("--read-only")
    }
    this.addProcess({
      name: `rclone-mount-${validated.name}`,
      command,
      environment: env,
    })
  }

  private validateVolumeSpec(spec: VolumeSpec): void {
    switch (spec.type) {
      case "local": {
        if (!spec.source) {
          throw new ValidationError({ message: `Volume ${spec.name}: local volumes require a source path` })
        }
        break
      }
      case "s3":
      case "gcs": {
        if (!spec.bucket) {
          const label = spec.type === "s3" ? "S3" : "GCS"
          throw new ValidationError({ message: `Volume ${spec.name}: ${label} volumes require a bucket` })
        }
        break
      }
      case "azure": {
        if (!spec.account) {
          throw new ValidationError({ message: `Volume ${spec.name}: azure volumes require an account` })
        }
        if (!spec.container) {
          throw new ValidationError({ message: `Volume ${spec.name}: azure volumes require a container` })
        }
        break
      }
      case "sftp": {
        if (!spec.host) {
          throw new ValidationError({ message: `Volume ${spec.name}: sftp volumes require a host` })
        }
        if (!spec.path) {
          throw new ValidationError({ message: `Volume ${spec.name}: sftp volumes require a path` })
        }
        break
      }
      case "smb": {
        if (!spec.host) {
          throw new ValidationError({ message: `Volume ${spec.name}: smb volumes require a host` })
        }
        if (!spec.share) {
          throw new ValidationError({ message: `Volume ${spec.name}: smb volumes require a share` })
        }
        break
      }
      case "webdav": {
        if (!spec.url) {
          throw new ValidationError({ message: `Volume ${spec.name}: webdav volumes require a url` })
        }
        break
      }
      case "dropbox":
      case "gdrive": {
        if (!spec.path) {
          throw new ValidationError({ message: `Volume ${spec.name}: ${spec.type} volumes require a path` })
        }
        break
      }
    }
  }

  private rcloneRemote(volume: Volume): string {
    switch (volume.type) {
      case "s3": {
        const prefix = volume.prefix || ""
        return `s3:${volume.bucket}/${prefix}`
      }
      case "gcs": {
        const prefix = volume.prefix || ""
        return `gcs:${volume.bucket}/${prefix}`
      }
      case "azure": {
        const path = volume.path || ""
        return `azure:${volume.container}/${path}`
      }
      case "sftp": {
        return `sftp:${volume.path}`
      }
      case "smb": {
        return `smb:${volume.host}/${volume.share}`
      }
      case "webdav": {
        const path = volume.path || ""
        return `webdav:${path}`
      }
      case "dropbox":
        return `dropbox:${volume.path}`
      case "gdrive":
        return `drive:${volume.path}`
      default:
        throw new ValidationError({ message: `Unsupported volume type for rclone: ${volume.type}` })
    }
  }

  private buildRcloneEnv(volume: Volume): Record<string, string> {
    const env: Record<string, string> = {}
    if (!volume.credentials) return env

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
    }

    // Provider-level settings that are not credentials but still configure rclone.
    if (volume.type === "sftp" && volume.host) {
      env.RCLONE_SFTP_HOST = volume.host
      if (volume.port) env.RCLONE_SFTP_PORT = String(volume.port)
    }
    if (volume.type === "smb" && volume.host) {
      env.RCLONE_SMB_HOST = volume.host
    }
    if (volume.type === "azure" && volume.account) {
      env.RCLONE_AZURE_ACCOUNT = volume.account
    }
    if (volume.type === "webdav" && volume.url) {
      env.RCLONE_WEBDAV_URL = volume.url
      if (volume.vendor) env.RCLONE_WEBDAV_VENDOR = volume.vendor
    }

    const map = mappings[volume.type]
    for (const [key, value] of Object.entries(volume.credentials)) {
      const rcloneKey = map[key]
      if (!rcloneKey) continue
      env[rcloneKey] = typeof value === "string" ? value : `\${${value.env}}`
    }

    return env
  }

  // Volume wrappers — thin helpers that delegate to addVolume with the right
  // provider-specific shape and credential mapping.

  addLocalVolume(spec: LocalVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "local",
      source: spec.source,
      target: spec.target,
      options: spec.options,
    })
  }

  addS3Volume(spec: S3VolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "s3",
      bucket: spec.bucket,
      prefix: spec.prefix,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      options: spec.options,
    })
  }

  addGcsVolume(spec: GcsVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "gcs",
      bucket: spec.bucket,
      prefix: spec.prefix,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      options: spec.options,
    })
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
      options: spec.options,
    })
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
      options: spec.options,
    })
  }

  addSmbVolume(spec: SmbVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "smb",
      host: spec.host,
      share: spec.share,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      options: spec.options,
    })
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
      options: spec.options,
    })
  }

  addDropboxVolume(spec: DropboxVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "dropbox",
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      options: spec.options,
    })
  }

  addGdriveVolume(spec: GdriveVolumeSpec): void {
    this.addVolume({
      name: spec.name,
      type: "gdrive",
      path: spec.path,
      target: spec.target,
      credentials: this.normalizeCredentials(spec.credentials),
      options: spec.options,
    })
  }

  private normalizeCredentials(
    credentials: Record<string, SecretValue | undefined>
  ): Record<string, SecretValue> {
    const result: Record<string, SecretValue> = {}
    for (const [key, value] of Object.entries(credentials)) {
      if (value !== undefined) {
        result[key] = value
      }
    }
    return result
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
      // Variables declared via addEnv take precedence over process-level env.
      // This prevents a process's local environment from silently overwriting
      // a value the user explicitly declared with addEnv.
      if (this.plan.runtime.envVars.some((e) => e.key === key)) continue
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

  enableVendorVolume(): void {
    this.plan.build.vendorVolume = true
  }

  configureMcp(port: number): void {
    this.plan.build.mcpEnabled = true
    this.plan.build.mcpPort = port

    // The MCP server is a Node script. Ensure a Node runtime is present without
    // clobbering an explicit node request the user may already have made.
    const hasNode = this.plan.build.languageRequests.some((r) => r.name === "node")
    if (!hasNode) {
      this.addLanguage("node", { version: "20" })
    }

    this.addProcess({
      name: "biodome-mcp",
      command: [
        "node",
        "/workspace/.biodome-build/mcp-server.js",
        "--port", String(port),
        "--plan", "/workspace/.biodome-build/plan.json",
      ],
      port,
      healthCheck: { type: "http", url: `http://localhost:${port}/health` },
    })
  }
}
