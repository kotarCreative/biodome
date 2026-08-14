import { Schema } from "effect";
import { type Plan, type Repo, RepoSpecSchema } from "../plan.js";
import type { HookSpec, RepoSpec } from "../feature.js";
import { ValidationError } from "../errors.js";

// Safe repository name: letters, digits, hyphens, underscores, and dots.
// Must not start with a dot or hyphen and must not contain path separators or
// shell metacharacters.
const REPO_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export class RepositoryBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly addAptPackage: (name: string) => void,
    private readonly addHook: (spec: HookSpec) => void,
    private readonly repositoriesPath: string,
  ) {}

  add(spec: RepoSpec): void {
    const validated = Schema.decodeSync(RepoSpecSchema)(spec);
    if (!REPO_NAME_PATTERN.test(validated.name)) {
      throw new ValidationError({
        message: `Repo name "${validated.name}" is invalid; use only letters, digits, hyphens, underscores, and dots, and do not start with "-" or "."`,
      });
    }
    if (this.plan.runtime.repos.some((repo) => repo.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate repo name: ${validated.name}` });
    }

    this.rejectUrlUserinfo(validated.url, validated.name);

    if (validated.credentials?.sshKey && !validated.credentials.knownHosts) {
      throw new ValidationError({
        message: `Repo ${validated.name}: knownHosts is required when using an SSH key`,
      });
    }

    const repo: Repo = {
      name: validated.name,
      url: validated.url,
      path: this.normalizePath(validated.path, validated.name),
      branch: validated.branch || "main",
      depth: validated.depth,
      credentials: validated.credentials ? { ...validated.credentials } : undefined,
    };
    this.plan.runtime.repos.push(repo);
    this.addAptPackage("git");
    this.addAptPackage("openssh-client");
    this.addHook({
      name: `repo-sync-${validated.name}`,
      command: ["sh", `${this.repositoriesPath}/${validated.name}.sh`],
      startOn: "start.pre",
    });
  }

  private rejectUrlUserinfo(url: string, name: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        throw new ValidationError({
          message: `Repo ${name}: URL must not contain userinfo (username:password); use credentials.token for HTTPS or credentials.sshKey for SSH`,
        });
      }
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      // Invalid URLs are left for git to report; we only reject embedded credentials.
    }
  }

  private normalizePath(path: string | undefined, name: string): string {
    if (!path) return `/workspace/repos/${name}`;
    return path.startsWith("/") ? path : `/workspace/${path}`;
  }
}
