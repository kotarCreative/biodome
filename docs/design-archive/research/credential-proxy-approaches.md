# Credential Management via Proxy & Sidecar Approaches

## The Problem

The current design injects credentials as environment variables into sandbox containers. Any process inside the sandbox — including AI agents — can read `process.env` or `/proc/self/environ` and exfiltrate credentials. A malicious or compromised agent can use those credentials to perform actions the developer never intended.

**Goal:** Allow sandbox agents to _use_ connected platforms (GitHub, AWS, Databases, APIs) without ever possessing the raw credentials.

---

## Approach 1: Local Authentication Proxy (Sidecar)

Run a lightweight proxy _inside_ the sandbox container (or as a companion container) that handles authentication. The agent connects to `localhost:PORT` and the proxy injects credentials transparently.

### Architecture

```
┌─────────────────────────────────────────┐
│             Sandbox Container            │
│                                          │
│  ┌──────────┐     ┌───────────────────┐  │
│  │  Agent   │────▶│  Auth Proxy       │  │
│  │ (process)│     │  localhost:8080   │  │
│  └──────────┘     │                   │  │
│                   │  - Holds creds    │  │
│                   │  - Attaches auth  │  │
│                   │  - Validates reqs │  │
│                   └────────┬──────────┘  │
│                            │              │
└────────────────────────────┼──────────────┘
                             │
                    ┌────────▼──────────┐
                    │  API / Platform   │
                    │  (GitHub, AWS,    │
                    │   DB, etc.)       │
                    └───────────────────┘
```

### Patterns

#### a) HTTP Forward Proxy (for REST APIs)

```
Agent ──▶ localhost:8080 ──▶ Proxy attaches `Authorization: Bearer <token>` ──▶ api.github.com
```

- Agent sets `HTTP_PROXY=http://localhost:8080` or talks to a rewritten base URL
- Proxy inspects the destination, looks up the matching credential from its in-memory store
- Proxy attaches the auth header, rewrites the request, forwards to the real API
- Agent never sees the token — not in env vars, not in files

#### b) TCP/UDP Proxy (for databases, Redis, etc.)

```
Agent ──▶ localhost:5432 ──▶ Proxy does TLS + password auth ──▶ real-postgres:5432
```

- Agent connects to a local port that the proxy listens on
- Proxy handles the protocol-level auth handshake (e.g., PostgreSQL SASL, Redis AUTH)
- Agent only sees the local unauthenticated connection

#### c) Git Credential Proxy

```
git clone http://localhost:8080/org/repo
```

- Git's `insteadOf` config rewrites remotes to point at the proxy
- Proxy handles the OAuth/SSH handshake with GitHub/GitLab
- Agent never holds a deploy key or PAT

#### d) AWS Signature Proxy

```
Agent ──▶ localhost:9000 ──▶ Proxy signs with AWS SigV4 ──▶ actual-aws-endpoint
```

- Agent calls `http://localhost:9000` with standard AWS API JSON
- Proxy looks up the stored `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, signs the request
- Agent gets scoped, signed access without ever holding the key pair

### Implementation Sketch (Go)

```go
type CredentialProxy struct {
    creds    map[string]Credential  // populated at sandbox init
    upstream map[string]string      // service -> real endpoint
}

func (p *CredentialProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    upstream := p.resolveUpstream(r.Host)
    cred := p.lookupCredential(upstream)

    // Clone the request, attach auth
    proxyReq, _ := http.NewRequest(r.Method, upstream + r.URL.Path, r.Body)
    cred.Attach(proxyReq) // adds header, signs, etc.

    resp, _ := http.DefaultClient.Do(proxyReq)
    // copy response back
}
```

### Pros

- Agent never possesses raw credentials — no exfiltration possible
- Per-request validation (can block dangerous operations)
- Audit logging of every proxied request
- Credentials stay in a single process boundary
- Can rotate credentials without agent awareness

### Cons

- Only works for network-accessible services (HTTP, TCP protocols)
- Need a proxy per protocol (HTTP proxy, PG proxy, Redis proxy)
- Adds latency (one hop inside the container)
- Agent must be configured to use the proxy

---

## Approach 2: MCP-Based Credential Gateway

Use the [Model Context Protocol](https://modelcontextprotocol.io) as the credential boundary. The sandbox runs an MCP server that exposes _capabilities_ rather than credentials. The AI agent connects to the MCP server and asks it to perform actions; the MCP server holds the credentials internally.

### Architecture

```
┌──────────────────────────────────────────┐
│            Sandbox Container              │
│                                           │
│  ┌──────────┐     ┌───────────────────┐   │
│  │  Agent   │◀───▶│  MCP Gateway      │   │
│  │ (AI/LLM) │     │  (Stdio/SSE)      │   │
│  └──────────┘     │                   │   │
│                   │  Tools:           │   │
│                   │  - github_pr()    │   │
│                   │  - aws_s3_list()  │   │
│                   │  - db_query()     │   │
│                   │                   │   │
│                   │  Credentials:     │   │
│                   │  - In memory only │   │
│                   └────────┬──────────┘   │
│                            │               │
└────────────────────────────┼───────────────┘
                             │
                    ┌────────▼──────────┐
                    │  API / Platform   │
                    └───────────────────┘
```

### How it Works

1. `sandbox up` creates the sandbox and starts an **MCP gateway server** as a sidecar
2. The MCP server is initialized with the resolved credentials (from `~/.sandbox/secrets.enc`)
3. The MCP server exposes tools like `github_create_pr`, `aws_s3_read`, `postgres_query`
4. The AI agent connects to the MCP server (stdio or SSE) and calls these tools
5. The MCP server executes the API call with the real credentials, returns results
6. Agent never sees the credential — only the result of the action

### Tool Definition Example

```go
// The MCP gateway defines tools, not credential surfaces
type MCPGateway struct {
    creds *secret.Manager
}

func (g *MCPGateway) Tools() []Tool {
    return []Tool{
        {
            Name: "github_create_pr",
            Input: json.RawMessage(`{
                "repo": "string",
                "title": "string",
                "body": "string",
                "head": "string",
                "base": "string"
            }`),
            Handler: func(ctx context.Context, input json.RawMessage) (string, error) {
                // g.creds is in memory, never exposed to agent
                token, _ := g.creds.Resolve(ctx, "github_token")
                gh := github.NewClient(token)
                pr, err := gh.CreatePR(input)
                return pr.URL, err
            },
        },
    }
}
```

### Credential Resolution Flow

```
┌──────────┐        ┌──────────────┐        ┌───────────────┐
│ sandbox  │───────▶│ MCP Gateway  │───────▶│ Secret Store  │
│ CLI      │ Init() │ Server       │ Resolve │ ~/.sandbox/   │
└──────────┘        │              │        │ secrets.enc   │
                    │              │        └───────────────┘
                    │  Holds creds │
                    │  in memory   │
                    │  for session │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ AI Agent     │
                    │ (tools only) │
                    └──────────────┘
```

### Pros

- Agent never has raw credentials — only scoped tool access
- Each tool can enforce its own authorization (read-only tools, scoped actions)
- Natural fit for LLM-based agents (already use MCP)
- Full audit trail: every tool call is logged
- Can implement rate limiting, cost controls, allow/deny lists

### Cons

- Only works with MCP-compatible agents (OpenCode, Claude Desktop, etc.)
- Limited to tools you explicitly define — agent can't run arbitrary `curl` commands
- More development effort to define and maintain tool surfaces
- Not suitable for general-purpose tools (like git, npm, terraform)

---

## Approach 3: Short-Lived Token Vending (STS Pattern)

Instead of giving the agent permanent credentials, vend short-lived, scoped tokens that expire quickly. The biodome acts as a Security Token Service (STS).

### Architecture

```
┌──────────────────────────────────────────┐
│            Sandbox Manager (Host)         │
│                                           │
│  ┌──────────────┐    ┌──────────────────┐ │
│  │ Local Secret │    │ Token Vender     │ │
│  │ Store        │───▶│ STS Service      │ │
│  │ (encrypted)  │    │                  │ │
│  └──────────────┘    │ - github_token   │ │
│                      │   (1hr, public   │ │
│                      │    repos only)   │ │
│                      │ - aws_creds      │ │
│                      │   (15min, S3     │ │
│                      │    read only)    │ │
│                      └────────┬─────────┘ │
│                               │            │
└───────────────────────────────┼────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   Sandbox Container    │
                    │                        │
                    │  Agent gets tokens     │
                    │  via:                  │
                    │  - HTTP endpoint       │
                    │  - Unix socket         │
                    │  - MCP tool            │
                    │  - env var (injected)  │
                    └────────────────────────┘
```

### How it Vends

| Platform | Token Type       | Typical Scope                   | Lifetime  |
| -------- | ---------------- | ------------------------------- | --------- |
| GitHub   | Fine-grained PAT | `repo:read`, `issues:write`     | 1-8 hours |
| AWS      | STS AssumeRole   | S3 read-only on specific bucket | 15-60 min |
| GCP      | Access Token     | Specific IAM role               | 1 hour    |
| GitHub   | OAuth App token  | Repository-level                | Session   |
| Database | Temp password    | `SELECT` only on `staging_*`    | 1 hour    |

### Env Var Injection (Still Not Ideal)

Even with short-lived tokens, injecting via env vars means the agent _has_ them. Better to combine with the proxy approach — the STS vends tokens to the proxy, not to the agent.

### Better: STS + Proxy

```
1. sandbox starts
2. STS vends short-lived token to the proxy only (Unix socket, not env var)
3. Agent connects to proxy: localhost:8080
4. Proxy authenticates using the short-lived token
5. Token expires; proxy fetches a new one (agent is unaware)
```

### Pros

- Limits blast radius: a leaked token expires quickly
- Scoped tokens limit what a compromised agent can do
- Can rotate without sandbox restart (proxy refreshes automatically)
- Compatible with existing cloud IAM systems (AWS STS, GCP IAM)

### Cons

- STS setup is platform-specific (complex for GitHub, simpler for AWS)
- Still need to protect the STS itself (who calls AssumeRole?)
- Short-lived tokens need refresh logic in the proxy
- Not all services support scoped token vending

---

## Approach 4: Host-Level Credential Agent (SSH-Agent Pattern)

Inspired by `ssh-agent`: run a credential agent on the _host_ that forwards capabilities into the sandbox via a Unix socket mount. The agent never transmits the raw secret — it performs operations on behalf of the sandbox.

### Architecture

```
┌─────────────────────────────────────┐
│             Host Machine             │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Credential Agent Daemon       │  │
│  │  (sandbox-cred-agent)          │  │
│  │                                │  │
│  │  - Holds decrypted secrets     │  │
│  │  - Listens on Unix socket      │  │
│  │  - Performs cryptographic ops  │  │
│  │  - Never sends key material    │  │
│  └──────────┬─────────────────────┘  │
│             │ Unix socket mount       │
└─────────────┼───────────────────────┘
              │
    ┌─────────▼──────────┐
    │  Sandbox Container  │
    │                     │
    │  ┌───────────────┐  │
    │  │ Agent / App   │  │
    │  │               │  │
    │  │ Talks to      │  │
    │  │ /tmp/cred.sock│  │
    │  └───────────────┘  │
    └─────────────────────┘
```

### Capabilities

Instead of requesting a credential, the agent requests an _operation_:

```go
// Agent sends to Unix socket:
{
    "op": "git.clone",
    "repo": "github.com/org/private-repo",
    "dest": "/workspace/repo"
}

// Credential agent performs:
// 1. Loads SSH key from encrypted store
// 2. Establishes SSH connection
// 3. Runs git clone
// 4. Returns result (never the key)

// Alternative: signing operation
{
    "op": "aws.sign_v4",
    "method": "GET",
    "url": "https://s3.amazonaws.com/bucket/object",
    "body": ""
}

// Credential agent signs with stored AWS key, returns signed headers
{
    "headers": {
        "Authorization": "AWS4-HMAC-SHA256 ...",
        "X-Amz-Date": "20260705T120000Z"
    }
}
```

### Integration with Docker

```go
// When creating the sandbox container:
func (m *Manager) Up(ctx context.Context, config *sandbox.Config) error {
    // Start credential agent on host
    agent := startCredentialAgent(ctx, config.Secrets)

    // Mount the Unix socket into the container
    container, err := m.docker.CreateContainer(&docker.Config{
        Image: config.Image,
        Mounts: []docker.Mount{
            {
                Type:   "bind",
                Source: agent.SocketPath,
                Target: "/tmp/cred.sock",
            },
        },
    })
}
```

### Pros

- Raw credentials never enter the container — physically impossible to exfiltrate
- Fine-grained operation control (not just "has token, does anything")
- Full audit trail of every operation requested
- Can implement per-operation approval (rate limits, deny lists)
- Unix socket is container-native (no network overhead)

### Cons

- Requires a host daemon (more complexity in setup)
- Agent/app must be credential-agent-aware or use a wrapper
- Only works for operations the agent supports (not arbitrary curl)
- Socket must be mounted at container creation time

---

## Approach 5: Envoy-Based Service Mesh Sidecar

Run a full-featured proxy sidecar (Envoy, HAProxy, or a small Go proxy) as a companion container in the sandbox pod. The sidecard handles all authentication, authorization, and mTLS.

### Architecture (Docker Compose)

```yaml
# Generated by biodome
services:
  app:
    image: sandbox-myapp:latest
    # Agent runs here, WITH NO CREDENTIALS
    environment:
      # No API keys, no tokens, no secrets
      GITHUB_API: "http://proxy:8080"
      AWS_ENDPOINT: "http://proxy:9000"
      DATABASE_URL: "postgres://proxy:5432/mydb"

  proxy:
    image: sandbox-credential-proxy:latest
    # Sidecar holds all credentials
    environment:
      GITHUB_TOKEN: "${GITHUB_TOKEN}" # Injected by sandbox CLI
      AWS_ACCESS_KEY_ID: "${AWS_AK}" # from local secret store
      AWS_SECRET_ACCESS_KEY: "${AWS_SK}"
      DATABASE_PASSWORD: "${DB_PASS}"
    # Proxy translates auth for each upstream
```

### Envoy Configuration

```yaml
static_resources:
  listeners:
    - name: github_proxy
      address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": ...
                route_config:
                  virtual_hosts:
                    - name: github
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/" }
                          route: { cluster: real_github }
                http_filters:
                  - name: envoy.filters.http.header_mutation
                    typed_config:
                      mutations:
                        - append:
                            header:
                              {
                                key: "Authorization",
                                value: "Bearer %REQ(CREDENTIALS:GITHUB_TOKEN)%",
                              }
  clusters:
    - name: real_github
      type: STRICT_DNS
      connect_timeout: 5s
      load_assignment:
        cluster_name: real_github
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address: { socket_address: { address: api.github.com, port_value: 443 } }
```

### Go Implementation (Lightweight)

For a simpler approach than Envoy, a small Go binary:

```go
// internal/sidecar/proxy.go
type SidecarProxy struct {
    creds   map[string]string
    proxies map[string]*ReverseProxy  // service name -> proxy
}

func NewSidecar(creds map[string]string) *SidecarProxy {
    return &SidecarProxy{
        creds: creds,
        proxies: map[string]*ReverseProxy{
            "github": newGithubProxy(creds["github_token"]),
            "aws":    newAWSProxy(creds["aws_key"], creds["aws_secret"]),
            "db":     newPostgresProxy(creds["db_password"]),
        },
    }
}

func (s *SidecarProxy) ListenAndServe() {
    // github: localhost:8080 -> api.github.com:443 (with bearer token)
    http.ListenAndServe(":8080", s.proxies["github"])
    // aws: localhost:9000 -> dynamodb.us-east-1.amazonaws.com:443 (with SigV4)
    http.ListenAndServe(":9000", s.proxies["aws"])
    // db: localhost:5432 -> actual-postgres-host:5432 (with password auth)
    tcp.ListenAndServe(":5432", s.proxies["db"])
}
```

### Pros

- Network-level isolation: no credential path into the app container
- Fine-grained per-route authorization (block dangerous API calls)
- Standard cloud pattern (Envoy, Linkerd, Istio)
- Can add observability (metrics, tracing) at the proxy layer
- Credentials can be rotated by restarting the sidecar only

### Cons

- Two containers per sandbox (more resource overhead)
- More complex orchestration (Docker Compose or K8s)
- Protocol-specific proxies needed (HTTP vs SQL vs Redis)
- Sidecar needs its own credential injection (still need to get creds to the sidecar)

---

## Comparison Matrix

| Approach               | Creds Enter Container? | Agent Has Raw Creds? | Protocol Support | Audit Trail | Complexity | Best For                |
| ---------------------- | ---------------------- | -------------------- | ---------------- | ----------- | ---------- | ----------------------- |
| **Env vars** (current) | Yes                    | Yes                  | All              | No          | Low        | Quick prototyping       |
| **Auth Proxy**         | Yes (proxy only)       | No                   | HTTP, TCP        | Yes         | Medium     | REST APIs, DBs          |
| **MCP Gateway**        | Yes (gateway only)     | No                   | MCP tools only   | Yes         | Medium     | AI/LLM agents           |
| **Token Vending**      | Yes (tokens)           | Yes*                 | All              | No          | Medium     | Cloud platforms         |
| **Cred Agent**         | No                     | No                   | Ops-based        | Yes         | High       | Sensitive SSH/Git       |
| **Sidecar**            | Yes (sidecar only)     | No                   | HTTP, TCP        | Yes         | High       | Multi-service sandboxes |

\* With STS + Proxy combination, agent does not have raw creds.

---

## Recommended Architecture: Layered Approach

No single pattern solves every use case. Recommended architecture combines them:

```
                                    ┌─────────────────────────────────┐
                                    │       Host (sandbox CLI)        │
                                    │                                 │
                                    │  ┌───────────────────────────┐  │
                                    │  │  Token Vender (STS)       │  │
                                    │  │  Vends scoped, short-lived │  │
                                    │  │  tokens from encrypted     │  │
                                    │  │  secret store              │  │
                                    │  └───────────┬───────────────┘  │
                                    └──────────────┼──────────────────┘
                                                   │
                          ┌────────────────────────┼────────────────────┐
                          │                        │                     │
                    ┌─────▼──────┐          ┌──────▼──────┐    ┌───────▼────────┐
                    │ MCP Gateway │          │ Auth Proxy  │    │ Cred Agent     │
                    │ (AI agents) │          │ (REST APIs) │    │ (Unix socket)  │
                    │             │          │             │    │ (ssh-agent)    │
                    │ Tools:      │          │ localhost:  │    │                │
                    │ - gh_pr     │          │ 8080=GitHub │    │ Ops:           │
                    │ - aws_list  │          │ 9000=AWS    │    │ - git.clone    │
                    │ - db_query  │          │ 5432=PG     │    │ - aws.sign     │
                    └─────────────┘          └─────────────┘    └────────────────┘
                          │                        │                     │
                    ┌─────▼────────────────────────▼─────────────────────▼─────┐
                    │                   Sandbox Container                      │
                    │                                                         │
                    │  - Agent connects to MCP for AI-native operations       │
                    │  - Agent connects to proxy for HTTP/TCP operations       │
                    │  - Agent connects to cred agent via socket for ops       │
                    │  - Agent NEVER has env vars with credentials             │
                    └─────────────────────────────────────────────────────────┘
```

### Phase-in Strategy

| Phase             | What                           | Why                                                                        |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------- |
| **Phase 1** (now) | Env var injection              | Works; builds the secret management foundation                             |
| **Phase 1.5**     | MCP Gateway                    | Natural for AI agents; define tool surfaces; reuses existing secret store  |
| **Phase 2**       | Auth Proxy for HTTP APIs       | Covers the bulk of 3rd-party integrations (GitHub, AWS, GCP, OpenAI, etc.) |
| **Phase 2+**      | TCP Proxy for DBs              | PostgreSQL, Redis, MySQL — covers service credentials                      |
| **Phase 3**       | Credential Agent (Unix socket) | For SSH/Git operations and signing                                         |
| **Phase 3+**      | STS Token Vending              | For delegating to cloud platforms with short-lived credentials             |

### Key Design Decision

The existing `SecretBackend` interface and `secret.Manager` already handle credential resolution and caching. Each proxy/sidecar component should be initialized with a `*secret.Manager` at sandbox startup — they resolve credentials once, hold them in memory, and never expose them:

```go
// Phase 2 example: sandbox up creates the credential proxy
func (m *Manager) Up(ctx context.Context, config *sandbox.Config) error {
    secrets := m.secrets  // *secret.Manager, already Init'd

    // Start the auth proxy with resolved credentials
    proxy := proxy.New(proxy.Config{
        GithubToken: secrets.Resolve(ctx, "github_token"),  // resolved once
        AWSAccessKey: secrets.Resolve(ctx, "aws_access_key_id"),
        AWSSecretKey: secrets.Resolve(ctx, "aws_secret_access_key"),
        DBPassword: secrets.Resolve(ctx, "db_password"),
    })
    go proxy.ListenAndServe(":8080", ":9000", ":5432")

    // Start MCP gateway with tool definitions
    mcp := mcp.NewGateway(secrets)
    go mcp.ListenAndServe()

    // Create container with NO credential env vars
    container := m.createSandbox(config, proxy.Ports(), mcp.Port())
    return container.Start(ctx)
}
```

The credential proxy itself can be:

- A separate binary shipped with biodome (`sandbox proxy`)
- A standalone Docker image (`sandbox-credential-proxy`)
- Embedded in the biodome binary and launched as a child process

---

## Summary

The current env-var approach is simple but fundamentally insecure for untrusted agents. The proxy/sidecar pattern — particularly the **MCP Gateway** for AI agents and the **Auth Proxy** for general HTTP APIs — provides the strongest security guarantees while remaining practical to implement. The existing `secret.Manager` and credential chaining infrastructure already provide the foundation; the proxies just consume from it instead of leaking to the agent.
