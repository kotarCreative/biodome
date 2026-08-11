import { describe, expect, it } from "vitest";
import { generateRepoScripts } from "../../../docker/generators/repositories.js";
import { createPlan } from "../../../core/plan.js";

describe("generateRepoScripts", () => {
  it("generates a clone script for a new repo", () => {
    const plan = createPlan("my-app");
    plan.runtime.repos.push({
      name: "backend",
      url: "https://github.com/acme/backend.git",
      path: "/workspace/repos/backend",
      branch: "main",
    });

    const scripts = generateRepoScripts(plan);
    const script = scripts["backend.sh"];
    expect(script).toContain("#!/bin/sh");
    expect(script).toContain("REPO_DIR=/workspace/repos/backend");
    expect(script).toContain(
      'git clone --branch main https://github.com/acme/backend.git "$REPO_DIR"',
    );
    expect(script).toContain('mkdir -p "$(dirname "$REPO_DIR")"');
    expect(script).toContain("git pull origin main");
  });

  it("includes a depth flag when configured", () => {
    const plan = createPlan("my-app");
    plan.runtime.repos.push({
      name: "backend",
      url: "https://github.com/acme/backend.git",
      path: "/workspace/repos/backend",
      branch: "main",
      depth: 1,
    });

    const scripts = generateRepoScripts(plan);
    expect(scripts["backend.sh"]).toContain(
      "git clone --branch main --depth 1 https://github.com/acme/backend.git",
    );
  });

  it("installs dependencies inside a cloned Python and Node repository", () => {
    const plan = createPlan("my-app");
    plan.build.languageRequests.push(
      { name: "python", options: { version: "3.12" } },
      { name: "node", options: { version: "20" } },
    );
    plan.runtime.repos.push({
      name: "backend",
      url: "https://github.com/acme/backend.git",
      path: "/workspace/apps/backend",
      branch: "main",
    });

    const script = generateRepoScripts(plan)["backend.sh"];
    expect(script).toContain('cd "$REPO_DIR"');
    expect(script).toContain("python -m pip install --no-cache-dir -r requirements.txt");
    expect(script).toContain("if [ -f package-lock.json ]; then npm ci; else npm install; fi");
  });

  it("injects a token into an https url", () => {
    const plan = createPlan("my-app");
    plan.runtime.repos.push({
      name: "backend",
      url: "https://github.com/acme/backend.git",
      path: "/workspace/repos/backend",
      branch: "main",
      credentials: { token: { env: "GITHUB_TOKEN" } },
    });

    const scripts = generateRepoScripts(plan);
    expect(scripts["backend.sh"]).toContain('if [ -z "$GITHUB_TOKEN" ]');
    expect(scripts["backend.sh"]).toContain("https://$GITHUB_TOKEN@github.com/acme/backend.git");
  });

  it("configures an ssh key for git over ssh", () => {
    const plan = createPlan("my-app");
    plan.runtime.repos.push({
      name: "backend",
      url: "git@github.com:acme/backend.git",
      path: "/workspace/repos/backend",
      branch: "main",
      credentials: { sshKey: { env: "BACKEND_SSH_KEY" } },
    });

    const scripts = generateRepoScripts(plan);
    expect(scripts["backend.sh"]).toContain('if [ -z "$BACKEND_SSH_KEY" ]');
    expect(scripts["backend.sh"]).toContain("/tmp/biodome-repo-keys/backend");
    expect(scripts["backend.sh"]).toContain("GIT_SSH_COMMAND");
  });
});
