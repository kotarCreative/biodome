import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
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
      startOn: "start.post",
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
        credentials: { token: "secret" },
      }),
    ).toThrow(/must be an environment reference/);
  });
});
