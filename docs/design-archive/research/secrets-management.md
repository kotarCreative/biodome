# Secrets Management for Sandbox Environments

## Overview

This document summarizes research findings on secrets management strategies for container-based development environments, focusing on approaches that work for AI sandbox tools like biodome.

---

## Current Landscape (What Works in Production)

### 1. Docker Secrets (BuildKit + Runtime)

#### Build-Level Secrets

**Recommended for:** Container builds that need private registries, internal APIs, or Git repositories during build.

**How it works:**

```bash
# Pass secret to build
docker build --secret id=npmrc,src=$HOME/.npmrc .
docker build --secret id=aws,src=$HOME/.aws/credentials .
docker build --secret id=github_token,src=$HOME/.ssh/github_token .

# Use in Dockerfile
RUN --mount=type=secret,id=npmrc \
    cat /run/secrets/npmrc > .npmrc && \
    npm install
```

**Source:** Docker BuildKit Secrets
- https://docs.docker.com/build/building/secrets/
- https://docs.docker.com/build/building/secrets/#secret-mounts

**For:** Building sandboxes that need to clone private repos or pull from private registries during image creation.

**Best for:** Prebuilt image generation in CI/CD pipelines.

---

#### SSH Agent Forwarding

**Recommended for:** Builds that need SSH keys, Git SSH access, or GPG signing.

**How it works:**

```bash
# Set up local SSH agent
eval $(ssh-agent)
ssh-add ~/.ssh/id_ed25519
ssh-add ~/.ssh/github_deploy_key

# Build with SSH agent forwarding
docker build --ssh default=$SSH_AUTH_SOCK .

# Use in Dockerfile
RUN --mount=type=ssh \
    git clone [[email protected]](/cdn-cgi/l/email-protection) :myorg/private-repo.git
```

**For:** Builds that need SSH credentials for private Git repositories or other SSH-based resources.

**Best for:** Sandboxes that clone private repositories during build.

---

### 2. DevPod Credentials (How DevPod Handles Secrets)

**Recommended for:** SSH-based development environments that need to forward local credentials.

**How DevPod handles secrets:**

#### Git Credentials

**Automatic injection:** DevPod automatically forwards Git credentials to workspace containers through SSH.

**Manual override:** Users can disable credential injection:

```bash
devpod context set-options default -o SSH_INJECT_GIT_CREDENTIALS=false
devpod up --no-ssh-git-credentials my-workspace
```

**Source:** DevPod Documentation
- https://devpod.sh/docs/developing-in-workspaces/credentials

**How DevPod passes Git credentials:**
1. Uses `ssh-agent` forwarding from local to container
2. Injects Git credentials automatically into SSH config
3. Allows users to override per-workspace for sensitive repos

**For:** Chat-based development environments that run Git operations from workspace terminals.

**Best for:** terminal-first AI coding environments.

---

#### Docker Credentials

**Automatic injection:** DevPod forwards Docker registry credentials to workspace containers.

**Manual override:**

```bash
devpod context set-options default -o SSH_INJECT_DOCKER_CREDENTIALS=false
devpod up --no-ssh-docker-credentials my-workspace
```

**For:** Workspaces that pull Docker images from private registries.

---

#### GPG Credentials

**Optional forwarding:** DevPod can forward GPG keys for signing commits.

**Enable:**

```bash
devpod up --gpg-agent-forwarding my-workspace
```

**For:** Workspaces that need GPG signing for Git commits or other operations.

---

### 3. GitHub Codespaces Secrets

**Recommended for:** Teams already using GitHub Codespaces with existing org/repository secrets.

**How it works:**

#### Development Environment Secrets

**Level:** Organization, Repository, or User

**Access:** Visible to codespaces created in repos with access to the secret level.

**Usage:** Set as environment variables in codespace:

```bash
# In codespace terminal
$ env | grep CODESPACES_SECRET_NAME
$ echo $CODESPACES_SECRET_NAME
```

**Source:** GitHub Codespaces Secrets
- https://docs.github.com/en/codespaces/managing-codespaces/managing-development-environment-secrets-for-your-repository-or-organization

**Key Features:**
- Encrypted secrets during transmission and storage
- Automatic injection into environment variables
- Access controls per organization/repository
- 48KB max size, 100 secrets per level

**For:** Teams already using GitHub Codespaces and want to use existing secrets.

**Best for:** Teams using GitHub actions + Codespaces together.

---

### 4. 1Password Secrets (Developer-Focused)

**Recommended for:** Teams that want human-friendly secret management that's also developer-friendly.

**How 1Password handles secrets:**

#### Secrets Automation

**Methods:**

- **1Password Service Accounts:** Programmatic access without human credentials
- **1Password Connect:** Self-hosted secret caching
- **CLI:** Command-line access to secrets

**Integration Methods:**

```bash
# Using 1Password CLI
op signin
op get item "API Key" --fields password > .env

# For CI/CD
export OP_SERVICE_ACCOUNT_TOKEN="xyz123"
op projects fetch "My Project" > .env

# In Docker builds
RUN op --service-account-token "$OP_SERVICE_ACCOUNT_TOKEN" \
    inject --item "API Key" /run/secrets/api_key
```

**Source:** 1Password Secrets Management
- https://www.1password.com/features/secrets-management/

**Key Advantages:**
- Zero-knowledge encryption
- Automatic retrieval via CLI/SDK
- Audit logging
- Automatic credential rotation support

**For:** Teams that need strong secret security with good developer experience.

**Best for:** Enterprise teams that want secrets automation without sacrificing developer experience.

---

### 5. SOPS + Age (Linux/Nix Approach)

**Recommended for:** Linux environments already using SOPS for secrets management.

**How it works (NixOS/Home Manager approach):**

#### SOPS with Age

**Workflow:**

1. Generate Age key pair from SSH key:

```bash
age-keygen -o ~/.config/sops/age/keys.txt
```

2. Configure `.sops.yaml`:

```yaml
creation_rules:
  - path_regex: secrets.yaml$
    key_groups:
      - age:
        - *publich-key*
```

3. Decrypt at runtime:

```nix
{ config, pkgs, ... }: {
  environment.systemPackages = [ pkgs.sops ];

  sops.secretFiles = {
    "my-secret" = {
      source = "secrets.yaml";
      key = ./age-privkey;
    };
  };

  environment.variables = {
    MY_APP_SECRET = config.sops.secretFiles."my-secret".content;
  };
}
```

**Source:** SOPS Documentation, nix-devenv

**Best for:** Teams already using SOPS for configuration management.

---

### 6. Fly.io Built-in Secrets

**Recommended for:** Applications that will run on Fly.io platform.

**How Fly.io handles secrets:**

#### Platform Management

**Methods:**

- **Fly Secret Command:** `fly secret set VAR=value`
- **Fly.toml:** Define secrets in configuration
- **Runtime:** Secrets available as environment variables in the running container

**Example:**

```yaml
# fly.toml
app = "my-app"

[env]
API_KEY = "{{ env.APP_API_KEY }}"

[[services]]
http_services = true

secret_env = [
  "APP_API_KEY"
]
```

```bash
# Command line
fly secret set DATABASE_URL=postgresql://localhost/db
fly secret set API_KEY=xyz123

# In container
$ echo $DATABASE_URL
```

**Source:** Fly.io Documentation

**For:** Applications targeting Fly.io platform.

**Best for:** Applications using Fly.io as the deployment platform.

---

### 7. Service Mesh Approaches

**Recommended for:** Complex applications with many microservices needing coordinated secret management.

**How it works (Istio/Envoy approach):**

#### JWT Token Handling

**Authentication flow:**

1. Secret manager stores JWT signing keys
2. Service mesh injects tokens into downstream services
3. Services validate and forward tokens as needed

**Example:**

```yaml
# Service Mesh Sidecar Config
apiVersion: v1
kind: Secret
metadata:
  name: jwt-signing-key
  annotations:
    istio.istio.io/method: "jwt"
    istio.istio.io/token_audience: "https://api.example.com"

type: Opaque
stringData:
  public-key.pem: |
    -----BEGIN PUBLIC KEY-----
    ...
    -----END PUBLIC KEY-----
  private-key.pem: |
    -----BEGIN RSA PRIVATE KEY-----
    ...
    -----END RSA PRIVATE KEY-----
```

**For:** Applications using service mesh for inter-service communication.

**Best for:** Microservices architectures with fine-grained access control.

---

## Sandbox Manager Secret Strategy Recommendations

### For Sandbox Manager (Based on Phase 1 MVP)

#### Build Time Secrets (Phase 1 - MVP)

**Primary Use Cases:**
- Clone private Git repositories
- Pull from private Docker registries
- Access internal APIs during build

**Recommended Approach:** Docker BuildKit Secrets

**Implementation:**

```yaml
# sandbox/secrets.yaml - Build secrets section
sandbox_secrets:
  # Git credentials for cloning private repos
  git_ssh_key: "${LOCAL_SSH_AGENT}"
  # Docker credentials for private registries  
  docker_config: "${LOCAL_DOCKER_CONFIG}"
  # Build-specific API keys
  build_api_key: "${BUILD_API_KEY}"

# Generated Dockerfile snippet
RUN --mount=type=secret,id=git_ssh_key \
    --mount=type=ssh \
    git clone [[email protected]](/cdn-cgi/l/email-protection) :org/private-repo.git && \
    git config --global user.email "${GIT_USER_EMAIL}" && \
    git config --global user.name "${GIT_USER_NAME}"
```

**Local Secrets Source:**

**SSH Agent:** Use local SSH agent for Git credentials
**Docker Config:** Use `docker login` credentials
**Environment Variables:** Source from local OS keyring (keyring, Windows Credential Manager)

#### Runtime Secrets (Phase 2+)

**Primary Use Cases:**
- Application configuration (database URLs, API keys)
- Runtime behavior control
- Service authentication

**Recommended Approaches:**
1. **Local Development:** Environment variables + file mounts
2. **Cloud Production:** Platform-specific secret managers
3. **Cross-platform:** Configuration + fallback to secrets manager

**Implementation:**

```yaml
# sandbox/secrets.yaml - Runtime secrets approach
runtime_secrets:
  environment_variables:
    # Auto-generated from service definitions
    DATABASE_URL: "${POSTGRES_INTERNAL_URL}"
    API_BASE_URL: "${CONFIGURED_API_BASE}"
  
  file_mounts:
    # Mount secrets files if needed
    - source: "${CONFIG_DIR}/.env"
      target: /workspace/.env
```

### Hybrid Approach Recommended

**Phase 1 (MVP):** Docker BuildKit secrets for build-only needs
**Phase 2 (v0.2+):** Runtime secrets support with secrets manager integration

**Required Capabilities:**

1. **Build Time Secrets:** 
   - SSH agent forwarding for Git
   - Docker config injection for registries
   - File-based secrets for build configuration

2. **Runtime Secrets:**
   - Environment variable injection
   - Optional file mounting
   - Secret manager integration (Phase 2+)

3. **Secret Sources:**
   - Local OS keyring (first-class)
   - Environment variables (second-class)
   - Platform-specific secrets (third-class)

---

## Implementation Strategy

### Phase 1: Core Secret Support

**Deliverables:**

1. **Build Secrets Support:**
   - SSH agent forwarding for Git cloning
   - Docker credential injection
   - GPG key forwarding (optional)

2. **Local Secret Sources:**
   - SSH agent (primary)
   - Docker config (secondary)
   - Environment variables (fallback)

3. **Secret Injection:**
   - Dockerfile generation with secret mounts
   - Runtime container execution with mounted secrets

4. **Secret Management:**
   - User credential sources configuration
   - Per-sandbox secret override capability

### Phase 2: Enhanced Secret Integration

**Deliverables:**

1. **Runtime Secrets:**
   - Environment variable injection
   - File system secret mounting
   - Service-discovery based secrets (e.g., database URLs)

2. **Secret Sources:**
   - 1Password integration (optional)
   - File-based secrets (primary)
   - Environment variables (secondary)
   - Platform secrets (third-party)

3. **Secret Manager Integration:**
   - 1Password Service Account
   - SOPS/age-based
   - Platform secrets (Fly.io, etc.)

### Phase 3: Advanced Secret Management

**Deliverables:**

1. **Secret Rotation:** Automated secret updates
2. **Secret Validation:** Integrity checking
3. **Secret Auditing:** Access logging and monitoring
4. **Enterprise Integration:** SAML/SSO support

---

## Comparison Matrix

| Secret Type | Docker BuildKit | DevPod | GitHub Codespaces | 1Password | Use Case |
|-------------|----------------|--------|------------------|-----------|----------|
| Git SSH | ✅ (SSH mount) | ✅ (automatic) | ❌ | ✅ | Private Git repos |
| Docker Registries | ✅ (`--secret type=env`) | ✅ (Docker credentials) | ✅ | ✅ | Private images |
| API Keys/Secrets | ✅ (file mounts) | ❌ | ✅ (envs) | ✅ (items) | Build-time config |
| Runtime Secrets | ❌ | ❌ | ✅ (envs) | ✅ | Application runtime |
| GPG Keys | ✅ (SSH mount) | ✅ (GPG forwarding) | ❌ | ✅ | Signing commits |
| Development Config | ❌ | ❌ | ✅ (envs) | ✅ (items) | Local development |

---

## Key Takeaways

1. **For MVP:** Use Docker BuildKit secrets with local SSH agent and Docker config injection.
2. **For Local Dev:** Leverage existing OS secret stores (SSH agent, Docker login, keyring).
3. **For Dev Experience:** Consider 1Password if team needs strong secret management with good CLI.
4. **For Deployment:** Platform-specific secrets (Fly.io) available for production.
5. **Future:** Add runtime secrets support with secrets manager integration.

---

## Sources

- Docker Build Secrets: https://docs.docker.com/build/building/secrets/
- DevPod Credentials: https://devpod.sh/docs/developing-in-workspaces/credentials
- GitHub Codespaces Secrets: https://docs.github.com/en/codespaces/managing-codespaces/managing-development-environment-secrets-for-your-repository-or-organization
- 1Password Secrets Automation: https://www.1password.com/features/secrets-management/
- SOPS Documentation: https://github.com/mozilla/sops
- Fly.io Secrets: https://fly.io/docs/reference/secrets/

---

## Quick Reference

### Bash (Local Development)

```bash
# Set up SSH agent for Git secrets
eval $(ssh-agent)
ssh-add ~/.ssh/id_ed25519

# Build with Git SSH
docker build --ssh default=$SSH_AUTH_SOCK -t sandbox .

# Run sandbox with secrets
SANDBOX_SECRETS="mysecret" docker compose up
```

### Dockerfile (Generated)

```dockerfile
# syntax=docker/dockerfile:1.2
FROM ubuntu

# Git setup with SSH secrets
RUN --mount=type=ssh \
    --mount=type=secret,id=git_config,target=/root/.gitconfig \
    apt-get update && \
    apt-get install -y git && \
    git config --global include /root/.gitconfig

# Clone private repo
RUN git clone [[email protected]](/cdn-cgi/l/email-protection) :org/private-repo.git /workspace

# Run application
CMD ["bash"]
```

### sandbox/ Directory (Config)

```yaml
# sandbox/config.yaml
name: my-app
```

```yaml
# sandbox/env.yaml
packages:
  apt:
    - curl
    - git
    - openssh-client
```

```yaml
# sandbox/secrets.yaml
git_ssh_key: "${LOCAL_SSH_AGENT}"
git_config: "${LOCAL_GIT_CONFIG}"
```