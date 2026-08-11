import type { Plan, Repo } from "../../core/plan.js";
import { shellQuote } from "./shell.js";

export function generateRepoScripts(plan: Plan): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const repo of plan.runtime.repos) {
    scripts[`${repo.name}.sh`] = repoSyncScript(repo, plan);
  }
  return scripts;
}

function repoSyncScript(repo: Repo, plan: Plan): string {
  const lines: string[] = ["#!/bin/sh", `# Auto-generated repo sync for ${repo.name}`, "set -e"];

  let cloneUrl = repo.url;
  const tokenRef = repo.credentials?.token;
  const sshKeyRef = repo.credentials?.sshKey;

  if (tokenRef && typeof tokenRef === "object") {
    lines.push(
      `if [ -z "$${tokenRef.env}" ]; then echo "Repo ${repo.name}: ${tokenRef.env} is not set"; exit 1; fi`,
    );
    // Rewrite https://host/path.git -> https://$TOKEN@host/path.git
    cloneUrl = cloneUrl.replace(/^https:\/\//, `https://$${tokenRef.env}@`);
  }

  if (sshKeyRef && typeof sshKeyRef === "object") {
    lines.push(
      `if [ -z "$${sshKeyRef.env}" ]; then echo "Repo ${repo.name}: ${sshKeyRef.env} is not set"; exit 1; fi`,
    );
    lines.push("mkdir -p /tmp/biodome-repo-keys");
    lines.push(`printf '%s' "$${sshKeyRef.env}" > /tmp/biodome-repo-keys/${repo.name}`);
    lines.push(`chmod 600 /tmp/biodome-repo-keys/${repo.name}`);
    lines.push("touch /tmp/biodome-repo-keys/known_hosts");
    lines.push("chmod 600 /tmp/biodome-repo-keys/known_hosts");
    lines.push(
      `export GIT_SSH_COMMAND='ssh -i /tmp/biodome-repo-keys/${repo.name} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/biodome-repo-keys/known_hosts'`,
    );
  }

  lines.push(`REPO_DIR=${shellQuote(repo.path)}`);
  lines.push('if [ -d "$REPO_DIR/.git" ]; then');
  lines.push('  cd "$REPO_DIR"');
  lines.push("  git fetch origin");
  lines.push(`  git checkout ${shellQuote(repo.branch)}`);
  lines.push(`  git pull origin ${shellQuote(repo.branch)}`);
  lines.push("else");
  lines.push('  mkdir -p "$(dirname "$REPO_DIR")"');
  const depthFlag = repo.depth !== undefined ? ` --depth ${repo.depth}` : "";
  lines.push(`  git clone --branch ${shellQuote(repo.branch)}${depthFlag} ${cloneUrl} "$REPO_DIR"`);
  lines.push("fi");
  lines.push('cd "$REPO_DIR"');
  lines.push(...repositoryDependencyCommands(plan));

  return lines.join("\n") + "\n";
}

function repositoryDependencyCommands(plan: Plan): string[] {
  const commands: string[] = [];
  const python = plan.build.languageRequests.find((request) => request.name === "python");
  if (python) {
    if (python.options.packageManager === "poetry") {
      commands.push("if [ -f pyproject.toml ]; then");
      commands.push("  python -m pip install --no-cache-dir poetry");
      commands.push("  poetry config virtualenvs.create false --local");
      commands.push("  poetry install --no-root");
      commands.push("fi");
    } else {
      commands.push("if [ -f requirements.txt ]; then");
      commands.push("  python -m pip install --no-cache-dir -r requirements.txt");
      commands.push("fi");
    }
  }

  const node = plan.build.languageRequests.find((request) => request.name === "node");
  if (node) {
    const manager = node.options.packageManager ?? "npm";
    if (manager === "pnpm") {
      commands.push("if [ -f package.json ]; then");
      commands.push("  corepack enable");
      commands.push("  corepack prepare pnpm@10 --activate");
      commands.push(
        "  if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi",
      );
      commands.push("fi");
    } else if (manager === "yarn") {
      commands.push("if [ -f package.json ]; then");
      commands.push("  corepack enable");
      commands.push("  corepack prepare yarn@stable --activate");
      commands.push(
        "  if [ -f yarn.lock ]; then yarn install --frozen-lockfile; else yarn install; fi",
      );
      commands.push("fi");
    } else {
      commands.push("if [ -f package.json ]; then");
      commands.push("  if [ -f package-lock.json ]; then npm ci; else npm install; fi");
      commands.push("fi");
    }
  }

  return commands;
}
