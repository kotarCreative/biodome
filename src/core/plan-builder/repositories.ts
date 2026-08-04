import { Schema } from "effect";
import { type Plan, type Repo, RepoSpecSchema } from "../plan.js";
import type { HookSpec, RepoSpec } from "../feature.js";
import { ValidationError } from "../errors.js";

export class RepositoryBuilder {
  constructor(
    private readonly plan: Plan,
    private readonly addAptPackage: (name: string) => void,
    private readonly addHook: (spec: HookSpec) => void,
    private readonly repositoriesPath: string,
  ) {}

  add(spec: RepoSpec): void {
    const validated = Schema.decodeSync(RepoSpecSchema)(spec);
    if (this.plan.runtime.repos.some((repo) => repo.name === validated.name)) {
      throw new ValidationError({ message: `Duplicate repo name: ${validated.name}` });
    }
    if (validated.credentials) {
      for (const [key, value] of Object.entries(validated.credentials)) {
        if (typeof value === "string") {
          throw new ValidationError({
            message: `Repo ${validated.name}: credentials.${key} must be an environment reference ({ env: "VAR" }), not a literal string`,
          });
        }
      }
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
      startOn: "start.post",
    });
  }

  private normalizePath(path: string | undefined, name: string): string {
    if (!path) return `/workspace/repos/${name}`;
    return path.startsWith("/") ? path : `/workspace/${path}`;
  }
}
