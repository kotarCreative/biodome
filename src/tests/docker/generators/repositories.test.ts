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
      "git clone --branch main 'https://github.com/acme/backend.git' \"$REPO_DIR\"",
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
      "git clone --branch main --depth 1 'https://github.com/acme/backend.git'",
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

  it("uses an ephemeral askpass helper for https tokens", () => {
    const plan = createPlan("my-app");
    plan.runtime.repos.push({
      name: "backend",
      url: "https://github.com/acme/backend.git",
      path: "/workspace/repos/backend",
      branch: "main",
      credentials: { token: { env: "GITHUB_TOKEN" } },
    });

    const scripts = generateRepoScripts(plan);
    const script = scripts["backend.sh"];
    expect(script).toContain('if [ -z "$GITHUB_TOKEN" ]');
    expect(script).toContain("GIT_ASKPASS");
    expect(script).toContain("GIT_TERMINAL_PROMPT=0");
    expect(script).toContain("git clone --branch main 'https://github.com/acme/backend.git'");
    expect(script).not.toMatch(/https:\/\/[^\s]*@[^\s]+/);
    expect(script).toContain("rm -f");
  });

  it("configures an ssh key with pinned known hosts", () => {
    const plan = createPlan("my-app");
    plan.runtime.repos.push({
      name: "backend",
      url: "git@github.com:acme/backend.git",
      path: "/workspace/repos/backend",
      branch: "main",
      credentials: {
        sshKey: { env: "BACKEND_SSH_KEY" },
        knownHosts:
          "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      },
    });

    const scripts = generateRepoScripts(plan);
    const script = scripts["backend.sh"];
    expect(script).toContain('if [ -z "$BACKEND_SSH_KEY" ]');
    expect(script).toContain("/tmp/biodome-repo-keys/backend");
    expect(script).toContain("GIT_SSH_COMMAND");
    expect(script).toContain("StrictHostKeyChecking=yes");
    expect(script).toContain(
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    );
    expect(script).not.toContain("accept-new");
  });
});
