import type { BuildContext } from "../build-context.js";
import { ValidationError } from "../errors.js";
import type { LanguageOptions, PackageOptions, ToolOptions } from "../feature.js";
import { getDefaultBaseImage, languageHandlers } from "../languages.js";
import { formatPackage } from "../packages.js";
import type { CopyArtifact, DependencyInstall, Plan } from "../plan.js";
import { toolHandlers } from "../tools.js";
import {
  assertAptPackageName,
  assertDockerImageRef,
  assertGoModulePath,
  assertIndexUrl,
  assertLanguageVersion,
  assertPackageName,
  assertPackageVersionSpec,
} from "../validation.js";

export class BuildBuilder implements BuildContext {
  constructor(
    private readonly plan: Plan,
    private readonly exists: (path: string) => boolean,
  ) {}

  addLanguage(name: string, options: LanguageOptions = {}): void {
    if (!languageHandlers[name]) return;
    if (options.version !== undefined) {
      assertLanguageVersion(options.version, name);
    }

    const existing = this.plan.build.languageRequests.findIndex((request) => request.name === name);
    if (existing >= 0) {
      this.plan.build.languageRequests[existing] = { name, options };
    } else {
      this.plan.build.languageRequests.push({ name, options });
    }
  }

  finalize(): void {
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
    if (options.version !== undefined) {
      assertPackageVersionSpec(options.version, manager);
    }
    if (options.indexUrl !== undefined) {
      assertIndexUrl(options.indexUrl, manager);
    }
    // npm supports scoped names; Go installs use module paths with dots and
    // slashes, so it gets its own check.
    if (manager === "go") {
      assertGoModulePath(name);
    } else {
      assertPackageName(name, manager);
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

  addTool(name: string, options: ToolOptions = {}): void {
    if (!name || typeof name !== "string") {
      throw new ValidationError({ message: "Tool requires a non-empty string name" });
    }
    const handler = toolHandlers[name];
    if (handler) {
      handler(this, options);
    } else {
      this.addAptPackage(name);
    }
  }

  setBaseImage(name: string): boolean {
    if (this.plan.build.baseImage) return false;
    assertDockerImageRef(name);
    this.plan.build.baseImage = name;
    return true;
  }

  requireDependencyFiles(files: string[]): string[] {
    const existing: string[] = [];
    for (const file of files) {
      if (!this.exists(file)) continue;
      existing.push(file);
      if (!this.plan.build.dependencyFiles.includes(file)) {
        this.plan.build.dependencyFiles.push(file);
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

  addAptPackage(name: string): void {
    assertAptPackageName(name);
    if (!this.plan.build.aptPackages.includes(name)) {
      this.plan.build.aptPackages.push(name);
    }
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

  fileExists(path: string): boolean {
    return this.exists(path);
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
}
