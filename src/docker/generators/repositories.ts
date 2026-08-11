import type { Plan, Repo } from "../../core/plan.js";
import { shellQuote } from "./shell.js";

export function generateRepoScripts(plan: Plan): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const repo of plan.runtime.repos) {
    scripts[`${repo.name}.sh`] = repoSyncScript(repo);
  }
  return scripts;
}

function repoSyncScript(repo: Repo): string {
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
  const depthFlag = repo.depth !== undefined ? ` --depth ${repo.depth}` : "";
  lines.push(`  git clone --branch ${shellQuote(repo.branch)}${depthFlag} ${cloneUrl} "$REPO_DIR"`);
  lines.push("fi");

  return lines.join("\n") + "\n";
}
