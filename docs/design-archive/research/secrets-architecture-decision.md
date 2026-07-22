# Secrets Architecture Decision: Multi-Provider vs. Unified Secret Manager

## Context

biodome needs to handle secrets in two contexts:

- **Build-time secrets**: SSH keys, Docker credentials, API keys needed during image builds
- **Runtime secrets**: Database URLs, API keys, service tokens needed when sandboxes run

The research in `secrets-management.md` surveyed 7 approaches (Docker BuildKit, DevPod, GitHub Codespaces, 1Password, SOPS+Age, Fly.io, Service Mesh). The existing recommendation is a hybrid approach: use Docker BuildKit for Phase 1 MVP, then add runtime secrets with secrets manager integration in Phase 2+.

This document evaluates whether to implement adapters for multiple distinct secret providers, or build a unified secret manager abstraction with pluggable backends.

## Analysis

### Option A: Multi-Provider Integration

Integrate directly with each provider's native API (1Password CLI, SOPS, Fly.io secrets, GitHub Codespaces secrets, etc.).

**Pros:**

- Leverages existing infrastructure — users who already use 1Password or GitHub Codespaces can keep their workflow
- Each provider handles its own encryption, rotation, and access control
- Familiar UX for users of each platform

**Cons:**

- High maintenance burden — each provider has a different API, auth model, and secret type support
- Users must configure and authenticate with each provider separately
- Provider-specific features leak into the core — e.g., 1Password vault paths, Fly.io env vars, SOPS file paths all become first-class config concepts
- Lock-in risk — switching providers means rewriting integration code
- The comparison matrix in `secrets-management.md` shows no single provider covers all secret types, so users would likely need _multiple_ integrations anyway
- Difficult to test — every provider integration requires real credentials and network access

### Option B: Unified Secret Manager with Pluggable Backends

Build an internal secret manager with a consistent interface. The manager stores secrets locally (encrypted at rest) and offers pluggable backends for sync/retrieval from external sources.

**Architecture:**

```
┌─────────────────────────────────────────────────┐
│                  biodome                 │
│  ┌───────────────────────────────────────────┐  │
│  │           Secret Manager (core)            │  │
│  │  - Encrypt at rest (age/AES-GCM)          │  │
│  │  - Consistent get/set/list/delete API     │  │
│  │  - Secret references (${{ secrets.X }})   │  │
│  └──────────┬────────────────────────────────┘  │
│             │                                      │
│  ┌──────────┴──────────┐  ┌──────────────────┐   │
│  │   Local Backend     │  │   Cloud Backend   │   │
│  │  - Encrypted file   │  │  - AWS Secrets    │   │
│  │  - OS keychain      │  │    Manager        │   │
│  │  - SOPS/age         │  │  - GCP Secret     │   │
│  └─────────────────────┘  │    Manager        │   │
│                           │  - Azure Key Vault│   │
│                           │  - Fly.io secrets │   │
│                           │  - 1Password SA   │   │
│                           └──────────────────┘   │
└─────────────────────────────────────────────────┘
```

**Key design:**

- The core secret manager owns the encryption and storage abstraction
- Backends are pure I/O providers — they read/write encrypted blobs or resolve secret references
- Secrets are referenced uniformly in `sandbox/secrets.yaml` as `${{ secrets.MY_KEY }}`
- Build-time secrets still use Docker BuildKit mounts under the hood (the manager resolves the value and passes it to BuildKit)
- The manager caches secrets locally during a sandbox session, avoiding repeated network calls

**Pros:**

- Single API surface — all secrets look the same to biodome regardless of origin
- Users configure _one_ backend, not multiple provider-specific config blocks
- Easy to test — the local encrypted file backend works offline with no credentials
- Future-proof — adding a new cloud provider is just implementing the backend interface
- Secrets can be migrated between backends without changing `sandbox/secrets.yaml`
- The local backend serves as the "batteries-included" default — biodome works out of the box

**Cons:**

- Does not directly use platform-native secret systems (e.g., GitHub Codespaces secrets would need a sync bridge)
- Requires maintaining the core encryption and caching layer
- Users who already have secrets in 1Password or SOPS will need to configure a backend bridge

### How This Maps to the Existing Roadmap

The existing Phase 1 approach (Docker BuildKit for build-time secrets) is unchanged — the secret manager resolves values and feeds them to BuildKit mounts. This works locally without any backend configuration.

For Phase 2+, instead of directly wiring 1Password, SOPS, and platform secrets as independent integrations, the roadmap would:

| Week    | Current Plan                        | Proposed Change                                                                   |
| ------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| Week 7  | Runtime secrets + service discovery | Same, but add the secret manager core with local encrypted backend                |
| Week 8  | 1Password integration               | Implement as a backend for the secret manager instead of a standalone integration |
| Week 9  | Provider abstraction                | Unchanged — provider abstraction is about compute, not secrets                    |
| Week 11 | Secrets rotation + audit            | Built into the secret manager core, applies to all backends uniformly             |
| Week 12 | Documentation                       | Document the backend interface for third-party contributions                      |

### Recommendation

**Build the unified secret manager (Option B).**

Rationale:

1. The project is greenfield — no legacy integrations to support
2. The multi-provider approach multiplies complexity without proportional benefit
3. A unified interface with pluggable backends gives the same flexibility with lower maintenance
4. The local encrypted backend means biodome works offline and out of the box
5. The backend interface is a natural extension point for community contributions (AWS, GCP, Azure, HashiCorp Vault, etc.)

### Backend Interface (Proposed)

```go
// SecretBackend resolves secret references to plaintext values.
type SecretBackend interface {
    // Name returns a human-readable name for the backend (e.g., "local", "aws", "1password").
    Name() string
    // Resolve retrieves the secret value for the given key.
    Resolve(ctx context.Context, key string) (string, error)
    // List returns all available secret keys this backend can resolve.
    List(ctx context.Context) ([]string, error)
    // Set stores a secret value (local backends only; cloud backends may return ErrReadOnly).
    Set(ctx context.Context, key, value string) error
}

// SecretManager is the core abstraction used by biodome.
type SecretManager struct {
    backend SecretBackend
    cache   map[string]string
}

func (m *SecretManager) Resolve(ctx context.Context, ref string) (string, error) {
    // ref is the key from ${{ secrets.X }} — not a backend-specific path
    return m.backend.Resolve(ctx, ref)
}
```

### Migration Path

| Phase         | Backend                                                                         | What Works                               |
| ------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| Phase 1 (MVP) | Local encrypted file (`~/.sandbox/secrets`)                                     | Build-time secrets via Docker BuildKit   |
| Phase 2       | OS keychain backend (macOS Keychain, GNOME Keyring, Windows Credential Manager) | Runtime secrets with local fallback      |
| Phase 2+      | 1Password backend, SOPS/age backend                                             | Enterprise secrets with existing tooling |
| Phase 3       | Cloud KMS backends (AWS, GCP, Azure)                                            | Production secrets in cloud deployments  |

---

## Credential Bootstrapping: How Backends Authenticate

The central challenge: cloud backends (AWS Secrets Manager, 1Password, GCP Secret Manager) each need _their own credentials_ to operate. How do we get those credentials into the backend without creating a circular dependency?

### Option 1: Environment Variables

Each backend reads well-known environment variables at initialization.

```go
type AWSBackend struct{}

func (b *AWSBackend) Init(ctx context.Context) error {
    // Standard AWS SDK credential chain:
    //   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
    //   ~/.aws/credentials
    //   IAM instance profile
    return nil  // AWS SDK handles this internally
}

type OnePasswordBackend struct{}

func (b *OnePasswordBackend) Init(ctx context.Context) error {
    token := os.Getenv("OP_SERVICE_ACCOUNT_TOKEN")
    if token == "" {
        return fmt.Errorf("OP_SERVICE_ACCOUNT_TOKEN not set")
    }
    return nil
}
```

**Pros:** Zero config for users already using these tools. Familiar pattern (AWS CLI, gcloud, etc.).

**Cons:** Not declarative — credentials are ambient, not managed. No way to express "use this specific 1Password vault" in config. Doesn't work for air-gapped / CI environments without env var plumbing.

---

### Option 2: Persistent Config File

A `~/.sandbox/config.yaml` stores backend-specific auth configuration:

```yaml
# ~/.sandbox/config.yaml
secrets:
  backend: "1password"
  backends:
    1password:
      service_account_token: "${OP_SERVICE_ACCOUNT_TOKEN}" # resolved at runtime
      vault: "engineering/sandboxes"
    aws:
      region: "us-east-1"
      profile: "biodome"
    local:
      path: "~/.sandbox/secrets"
```

The config file itself supports variable interpolation (referencing env vars), so tokens are never written in plaintext.

**Pros:** Declarative, repeatable, checkable into dotfile repos. Supports multiple backends simultaneously.

**Cons:** Still requires env vars (or manual entry) for the most sensitive tokens. Config file becomes a credential store itself.

---

### Option 3: Credential Chaining (Local Backend as Root of Trust)

The local encrypted backend serves as the root credential store for all other backends. Cloud backends resolve their own auth credentials from the local backend during initialization.

```
Initialization flow:

1. SecretManager starts
2. Local backend loads (needs no credentials — just decrypts ~/.sandbox/secrets with local key)
3. Cloud backend (e.g., AWS) calls localBackend.Resolve("aws_access_key_id")
4. Cloud backend authenticates and becomes operational
5. Application secrets are now resolvable from the cloud backend
```

```go
type AWSBackend struct {
    local LocalBackend
}

func (b *AWSBackend) Init(ctx context.Context) error {
    // Resolve our own credentials from the local backend
    keyID, _ := b.local.Resolve(ctx, "aws_access_key_id")
    secret, _ := b.local.Resolve(ctx, "aws_secret_access_key")
    region, _ := b.local.Resolve(ctx, "aws_region")
    // ... initialize AWS SDK session with these
}
```

**Setting up the chain:**

```bash
# One-time setup — store cloud backend creds in local backend
sandbox secrets set aws_access_key_id     "${AWS_ACCESS_KEY_ID}"
sandbox secrets set aws_secret_access_key "${AWS_SECRET_ACCESS_KEY}"
sandbox secrets set op_service_account_token "${OP_SERVICE_ACCOUNT_TOKEN}"

# These are encrypted at rest in ~/.sandbox/secrets
# Cloud backends now resolve their own creds from here automatically
```

**Pros:** Single source of truth. The local backend is always available (offline, air-gapped, CI). No env vars needed at runtime after initial setup. Clean dependency graph — no circular resolution.

**Cons:** One-time setup ceremony. If the local backend is corrupted or lost, all chained backends lose access. Users must trust the local key material.

---

### Option 4: Backend-Provided Credential Chains

Each backend defines its own credential resolution strategy (inspired by the AWS SDK's `CredentialsProvider` pattern):

```go
// CredentialProvider resolves auth credentials for a backend.
// Each backend defines its own resolution chain.
type CredentialProvider interface {
    Credentials(ctx context.Context) (AuthCredentials, error)
}

// Example: 1Password resolves creds from:
//   1. Local backend (if chained)
//   2. OP_SERVICE_ACCOUNT_TOKEN env var
//   3. ~/.op/config
//   4. Interactive prompt (CLI mode)
type OnePasswordProvider struct {
    local LocalBackend
    chain []CredentialSource
}

func (p *OnePasswordProvider) Credentials(ctx context.Context) (AuthCredentials, error) {
    for _, source := range p.chain {
        if creds, err := source.Resolve(ctx); err == nil {
            return creds, nil
        }
    }
    return nil, fmt.Errorf("no 1Password credentials found")
}
```

**Pros:** Flexible — each backend uses the best strategy for its ecosystem. Backward compatible with existing tool auth (env vars, config files, IAM roles).

**Cons:** More code per backend. The chain is backend-specific, so behavior is not uniform across backends.

---

### Recommended Approach: Hybrid (Env Vars + Credential Chaining + Login Command)

Combine the best of each:

1. **Backends check environment variables first** (for CI/CD and existing workflows)
2. **Fall back to credential chaining through the local backend** (for repeatable, declarative setups)
3. **`sandbox secrets login <backend>` command** for interactive authentication that stores credentials in the local backend for reuse

```go
func (b *AWSBackend) Init(ctx context.Context) error {
    // Attempt 1: AWS SDK default chain (env vars, ~/.aws/credentials, IAM)
    if sess, err := session.NewSession(); err == nil {
        b.sess = sess
        return nil
    }

    // Attempt 2: Credential chaining through local backend
    if b.local != nil {
        keyID, err := b.local.Resolve(ctx, "aws_access_key_id")
        if err == nil {
            // ... init with local creds
        }
    }

    // Attempt 3: Interactive login (TTY only)
    return fmt.Errorf("no AWS credentials found; run 'sandbox secrets login aws'")
}
```

**User workflow:**

```bash
# CI/CD: env vars just work
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
sandbox build

# Local dev: one-time login, creds persisted encrypted
sandbox secrets login aws
sandbox build  # resolves creds from local backend automatically

# Declarative setup: set in local backend explicitly
sandbox secrets set aws_access_key_id "AKIA..."
sandbox secrets set aws_secret_access_key "..."
```

**Why this works for biodome:**

- Phase 1 (local only): no credentials needed, works out of the box
- Phase 2 (1Password / cloud): set up once via `sandbox secrets login`, then forget
- CI/CD: env vars are the universal carrier — backends check them first

### Updated Backend Interface

```go
// SecretBackend resolves secret references to plaintext values.
type SecretBackend interface {
    Name() string

    // Init authenticates the backend using env vars, chained credentials,
    // or interactive login. Returns an error only if no credential source succeeds.
    Init(ctx context.Context, local LocalBackend) error

    Resolve(ctx context.Context, key string) (string, error)
    List(ctx context.Context) ([]string, error)
    Set(ctx context.Context, key, value string) error
}

// LocalBackend is the always-available root of trust, used for credential chaining.
type LocalBackend interface {
    SecretBackend
    // Can be used directly without Init — it's available as soon as the local key is decrypted.
}
```

The `Init` method receives the already-initialized local backend, enabling credential chaining without circular dependencies. Each backend's `Init` decides its own priority (env vars → chaining → login).

---

## Deploying Secrets to Providers

The same architecture that _resolves_ secrets can also _deploy_ them to providers. `Set` is already on the interface — it doesn't need to return `ErrReadOnly` for cloud backends.

### Why Deploy to Providers?

- **Bootstrap environments**: define secrets once locally, push to AWS/GCP/1Password
- **Migrate between providers**: `sandbox secrets sync --from 1password --to aws`
- **Disaster recovery**: backup cloud secrets to the local encrypted store
- **CI/CD pipelines**: generate a secret (e.g., a deploy key), deploy it to the provider, then consume it

### How It Works

The same credential chaining that authenticates `Resolve` also authenticates `Set` — the backend's `Init` establishes an authenticated session, and both methods use it:

```go
func (b *AWSBackend) Set(ctx context.Context, key, value string) error {
    input := &secretsmanager.PutSecretValueInput{
        SecretId:     aws.String(b.secretPrefix + key),
        SecretString: aws.String(value),
    }
    _, err := b.svc.PutSecretValue(ctx, input)
    return err
}
```

The only difference from `Resolve` is IAM permissions — the principal needs `secretsmanager:PutSecretValue` instead of just `secretsmanager:GetSecretValue`. This is handled at the cloud layer, not in biodome.

### Sync Command

A `sync` operation enables multi-provider workflows:

```bash
# Push local secrets to a cloud backend
sandbox secrets sync --from local --to aws

# Bidirectional sync between providers
sandbox secrets sync --from 1password --to aws --conflict prefer-source

# Backup cloud secrets to local encrypted store
sandbox secrets sync --from aws --to local

# Bulk import into 1Password during onboarding
sandbox secrets sync --from local --to 1password
```

The sync implementation is simple because both sides implement the same interface:

```go
func Sync(ctx context.Context, from, to SecretBackend, keys []string) error {
    for _, key := range keys {
        val, err := from.Resolve(ctx, key)
        if err != nil {
            return fmt.Errorf("resolve %s: %w", key, err)
        }
        if err := to.Set(ctx, key, val); err != nil {
            return fmt.Errorf("set %s: %w", key, err)
        }
    }
    return nil
}
```

### Security Implications

Making cloud backends writable raises the stakes on local backend security. Mitigations:

1. **The local backend encrypts at rest** — `~/.sandbox/secrets` is an encrypted blob, not plaintext
2. **OS keychain integration** — the local encryption key can live in the OS keychain (macOS Keychain, GNOME Keyring, Windows Credential Manager) rather than a file
3. **IAM permissions are external** — biodome never escalates privileges; it inherits whatever policy the caller has. A read-only IAM principal can only `Resolve`, never `Set`.
4. **Audit logging is provider-native** — AWS CloudTrail, 1Password audit log, etc. all track `Set` calls automatically
5. **Optional read-only mode** — `sandbox secrets set --backend aws` can be gated behind a config flag or the IAM policy itself

### Where This Fits in the Roadmap

| Phase         | Capability               | How It Works                                                           |
| ------------- | ------------------------ | ---------------------------------------------------------------------- |
| Phase 1 (MVP) | Build-time secrets       | Docker BuildKit mounts, no cloud backends needed                       |
| Phase 2       | Read from cloud backends | `Resolve` only; `Set` returns `ErrReadOnly` as a safe default          |
| Phase 2+      | Write to cloud backends  | Full `Set` + `Sync`; gated by IAM permissions and optional config flag |
| Phase 3       | Enterprise sync          | Cross-provider sync, rotation policies, audit integration              |
