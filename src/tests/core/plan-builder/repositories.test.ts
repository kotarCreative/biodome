import { describe, expect, it } from "vitest";
import { createPlan, type SecretReference } from "../../../core/plan.js";
import { RepositoryBuilder } from "../../../core/plan-builder/repositories.js";

function makeBuilder() {
  const plan = createPlan("test");
  const packages: string[] = [];
  const hooks: unknown[] = [];
  return {
    plan,
    packages,
    hooks,
    builder: new RepositoryBuilder(
      plan,
      (name) => packages.push(name),
      (spec) => hooks.push(spec),
      "/workspace/.biodome-build/repos",
    ),
  };
}

describe("RepositoryBuilder", () => {
  it("normalizes repository paths and adds clone dependencies and sync hook", () => {
    const { builder, hooks, packages, plan } = makeBuilder();
    builder.add({ name: "api", url: "https://example.com/api.git", path: "apps/api" });

    expect(plan.runtime.repos[0]).toMatchObject({ path: "/workspace/apps/api", branch: "main" });
    expect(packages).toEqual(["git", "openssh-client"]);
    expect(hooks).toContainEqual({
      name: "repo-sync-api",
      command: ["sh", "/workspace/.biodome-build/repos/api.sh"],
      startOn: "start.pre",
    });
  });

  it("rejects duplicate names and literal credentials", () => {
    const { builder } = makeBuilder();
    builder.add({ name: "api", url: "https://example.com/api.git" });

    expect(() => builder.add({ name: "api", url: "https://example.com/other.git" })).toThrow(
      /Duplicate repo name/,
    );
    expect(() =>
      builder.add({
        name: "private",
        url: "https://example.com/private.git",
        credentials: { token: "secret" as unknown as SecretReference },
      }),
    ).toThrow();
  });

  it("rejects unsafe repo names", () => {
    const { builder } = makeBuilder();
    expect(() => builder.add({ name: "../escape", url: "https://example.com/a.git" })).toThrow(
      /Repo name.*is invalid/,
    );
    expect(() => builder.add({ name: "-bad", url: "https://example.com/a.git" })).toThrow(
      /Repo name.*is invalid/,
    );
  });

  it("rejects URLs with embedded userinfo", () => {
    const { builder } = makeBuilder();
    expect(() => builder.add({ name: "bad", url: "https://user:pass@example.com/a.git" })).toThrow(
      /must not contain userinfo/,
    );
  });

  it("requires pinned known hosts for SSH keys", () => {
    const { builder } = makeBuilder();
    expect(() =>
      builder.add({
        name: "ssh-repo",
        url: "git@example.com:a.git",
        credentials: { sshKey: { env: "SSH_KEY" } },
      }),
    ).toThrow(/knownHosts is required when using an SSH key/);
  });
});
