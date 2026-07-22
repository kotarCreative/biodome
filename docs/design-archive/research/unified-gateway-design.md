# Unified Credential Gateway: Tool Builder + TCP Proxy

## The Goal

A single gateway that combines Executor.sh's structured tool-builder approach (semantic guardrails, context-efficient tool search, credential isolation) with TCP-level proxying for databases, SSH, Redis, and other non-HTTP services — all governed by the same credential security model and policy engine.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                    Unified Credential Gateway                       │
│                           (sandbox-gateway)                         │
│                                                                     │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐ │
│  │     MCP Tool Engine          │  │     TCP Proxy Layer          │ │
│  │     (structured tools)       │  │     (protocol-aware)         │ │
│  │                              │  │                              │ │
│  │  ┌────────────────────────┐  │  │  ┌────────────────────────┐  │ │
│  │  │ Tool Registry          │  │  │  │ Connection Pool        │  │ │
│  │  │ - OpenAPI → tools      │  │  │  │ - PostgreSQL proxy     │  │ │
│  │  │ - GraphQL → tools      │  │  │  │ - Redis proxy          │  │ │
│  │  │ - MCP servers → tools  │  │  │  │ - MySQL proxy          │  │ │
│  │  │ - Custom JS functions  │  │  │  │ - SSH tunnel           │  │ │
│  │  │ - Raw HTTP spec        │  │  │  │ - MongoDB proxy         │  │ │
│  │  └──────────┬─────────────┘  │  │  │ - Raw TCP filter       │  │ │
│  │             │                │  │  └──────────┬─────────────┘  │ │
│  │  ┌──────────▼─────────────┐  │  │             │                │ │
│  │  │ JS Sandbox (V8 isolate)│  │  │  ┌──────────▼─────────────┐  │ │
│  │  │ - Tool execution       │  │  │  │ Protocol Authentication│  │ │
│  │  │ - Auth injected host-  │  │  │  │ - SASL (PG, MySQL)     │  │ │
│  │  │   side, never in heap  │  │  │  │ - AUTH (Redis)         │  │ │
│  │  └────────────────────────┘  │  │  │ - Key exchange (SSH)   │  │ │
│  │                              │  │  └────────────────────────┘  │ │
│  └──────────────┬───────────────┘  └──────────────┬───────────────┘ │
│                 │                                  │                 │
│  ┌──────────────▼──────────────────────────────────▼───────────────┐ │
│  │                 Credential Vault (host-side)                    │ │
│  │  - Resolved from ~/.sandbox/secrets.enc at gateway init        │ │
│  │  - Held in memory, never exposed to sandbox or agent           │ │
│  │  - Injected at call time by proxy (MCP + TCP paths)            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              Unified Policy & Audit Engine                     │ │
│  │                                                                 │ │
│  │  Policies:                    Audit:                            │ │
│  │  - github.*.read  → allow    │  - Every MCP tool call logged   │ │
│  │  - github.*.write → approve  │  - Every TCP connection logged  │ │
│  │  - *.billing.*    → block    │  - Duration, bytes, result      │ │
│  │  - pg.production  → approve  │  - Structured metadata per op   │ │
│  │  - pg.staging     → allow    │  - Searchable audit trail       │ │
│  └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
                             │
                 ┌───────────┴───────────┐
                 │                       │
         ┌───────▼───────┐       ┌───────▼───────┐
         │  AI Agent      │       │  Your Tool    │
         │  (over MCP)    │       │  (over HTTP/  │
         │                │       │   TCP)        │
         └───────────────┘       └───────────────┘
```

---

## Component 1: MCP Tool Engine

Identical in concept to Executor.sh. Import any HTTP-based API as structured tools.

### How it Works

```yaml
# ~/.sandbox/gateway.yaml
sources:
  github:
    type: openapi
    spec: https://api.github.com/openapi.json
    connections:
      personal:
        auth:
          type: bearer
          secret_ref: op://personal/github-token # resolves via 1Password
      work:
        auth:
          type: bearer
          secret_ref: local://github_work_token # resolves via local store

  sentry:
    type: openapi
    spec: https://sentry.dev/api/0/openapi.json
    connections:
      prod:
        auth:
          type: bearer
          secret_ref: env://SENTRY_AUTH_TOKEN # resolves via env var
```

### Tool Surface

The agent sees a single MCP tool with meta-tools (same context-efficiency pattern as Executor):

```json
// Tools available to the agent (always just these 4):
[
  {
    "name": "tools.search",
    "description": "Search the tool catalog by intent",
    "input": { "query": "string" }
  },
  {
    "name": "tools.describe",
    "description": "Get the schema for a specific tool",
    "input": { "path": "github.work.issues.list" }
  },
  {
    "name": "tools.call",
    "description": "Execute a tool by path with input",
    "input": { "path": "string", "args": "object" }
  },
  {
    "name": "tools.run_code",
    "description": "Run arbitrary JS in the sandbox with access to tools",
    "input": { "code": "string" }
  }
]
```

Agent workflow:

```
1. tools.search("create a PR on my personal repos")
2. tools.describe("github.personal.pulls.create")
3. tools.call("github.personal.pulls.create", { owner: "...", ... })
```

[identical credential isolation: secrets resolved host-side, injected at call time, never enter sandbox]

---

## Component 2: TCP Proxy Layer

The extension beyond Executor. Protocol-aware proxies for non-HTTP services.

### Configuration

```yaml
# ~/.sandbox/gateway.yaml
tcp_proxies:
  postgres:
    bind: localhost:5432
    upstream: my-prod-db.cluster-xyz.us-east-1.rds.amazonaws.com:5432
    protocol: postgresql
    auth:
      username: app_user
      password_ref: local://prod_db_password
      database: myapp_prod
    policies:
      connect: approve # every new connection needs approval
      query_allowlist:
        - "SELECT * FROM users WHERE id = $1"
        - "SELECT * FROM orders WHERE user_id = $1 LIMIT $2"
      query_denylist:
        - "DROP *"
        - "ALTER *"
        - "TRUNCATE *"
        - "UPDATE users SET *" # can only SELECT from users

  redis:
    bind: localhost:6379
    upstream: redis-cluster.internal:6379
    protocol: redis
    auth:
      password_ref: local://redis_password
    policies:
      commands:
        allow: [GET, SET, EXISTS, TTL, EXPIRE, INCR, DEL]
        block: [FLUSHALL, FLUSHDB, CONFIG, SLAVEOF, DEBUG, SHUTDOWN, SAVE, BGSAVE, BGREWRITEAOF]

  mysql:
    bind: localhost:3306
    upstream: my-db.internal:3306
    protocol: mysql
    auth:
      username: readonly_user
      password_ref: local://mysql_password
    policies:
      connect: allow
      statements: read_only # rejects anything other than SELECT/SHOW

  ssh_github:
    bind: localhost:2222
    upstream: github.com:22
    protocol: ssh
    auth:
      key_ref: local://github_deploy_key
    policies:
      allowed_commands:
        - git-upload-pack
        - git-receive-pack # allow push/pull to specific repos
      allowed_repos:
        - my-org/private-repo
```

### Protocol Authentication

Each protocol needs its own auth handshake. The proxy terminates the auth and establishes a new authenticated connection to the upstream:

```
Agent → Proxy (no auth):          "Hey, start a PostgreSQL connection"
Proxy → Upstream (with creds):    "I have username 'app', password 'xxx'"

Agent → Proxy (no auth):          "AUTH <password>"
Proxy:                            "I'm handling auth, one moment..."
Proxy → Upstream:                 "AUTH correct-password"
Proxy → Agent:                    "+OK"
```

### TCP Policy Enforcement

The TCP proxy inspects protocol-level commands, not just raw bytes:

```go
type PostgresProxy struct {
    upstream string
    policies PostgresPolicies
}

func (p *PostgresProxy) HandleConnection(client net.Conn) {
    // 1. TLS termination
    // 2. SASL auth handshake (proxy logs in with credentials)
    // 3. Create authenticated connection to upstream
    // 4. For each client query:
    //    - Parse PostgreSQL wire protocol (parse/describe/bind/execute)
    //    - Extract the SQL statement
    //    - Check against query allowlist/denylist
    //    - Check policy (approve if destructive)
    //    - Forward to upstream or block
    // 5. Return result to client
}

// Supported protocol parsers:
// - PostgreSQL: parse "Q" (simple query), "P" (parse), "E" (execute) messages
// - Redis: parse RESP3 commands (GET, SET, FLUSHALL, etc.)
// - MySQL: parse COM_QUERY, COM_STMT_EXECUTE
// - MongoDB: parse OP_MSG wire protocol
// - SSH: parse channel request types
```

### Protocol Detection & Auto-Proxy

For services without a dedicated protocol parser, a generic TCP tunnel with port-based policy:

```yaml
tcp_proxies:
  raw_tunnel:
    bind: localhost:9999
    upstream: some-service.internal:9999
    protocol: tcp # generic TCP relay
    policies:
      connect: allow
      rate_limit: 10MB/min # raw bandwidth limits only
      allowed_ports: [] # not applicable for raw TCP
```

---

## Component 3: Unified Policy Engine

Policies for both MCP tools and TCP connections share the same evaluation engine.

### Policy Model

```yaml
policy:
  # MCP tool policies (path-based, like executor)
  tools:
    github.personal.*.read: allow
    github.work.*.write: require_approval
    github.*.billing.*: block
    aws.prod.s3.delete_object: require_approval
    aws.staging.s3.*: allow

  # TCP proxy policies (protocol-aware)
  proxies:
    postgres: # applies to the postgres proxy
      connect: allow # can always connect
      queries:
        - pattern: "DROP *"
          action: block
        - pattern: "ALTER *"
          action: block
        - pattern: "DELETE FROM users"
          action: require_approval
        - pattern: "SELECT *"
          action: allow
    redis:
      commands:
        - command: FLUSHALL
          action: block
        - command: KEYS
          action: block
        - command: EVAL
          action: require_approval

  # Global defaults
  default: require_approval # everything unknown needs approval
```

### Enforcement

```go
// Single enforcement point for both MCP and TCP
type PolicyEngine struct {
    store PolicyStore
}

func (e *PolicyEngine) Evaluate(ctx context.Context, req PolicyRequest) (PolicyResult, error) {
    // req.Path = "github.work.pulls.create" (MCP tool) OR
    // req.Path = "proxies.postgres.query" (TCP query)

    switch req.Kind {
    case KindTool:
        return e.evaluateToolPolicy(ctx, req)
    case KindTCPCommand:
        return e.evaluateTCPPolicy(ctx, req)
    }
}

type PolicyResult struct {
    Action       Action  // allow, require_approval, block
    AuditEntry   AuditEntry
}
```

---

## Component 4: Unified Audit

Every operation — MCP tool call or TCP connection — produces the same audit record shape:

```go
type AuditEntry struct {
    ID            string
    Timestamp     time.Time
    Kind          string    // "mcp_tool" | "tcp_connect" | "tcp_query"
    Source        string    // "github.work.pulls.create" or "proxies.postgres"
    Principal     string    // agent identity
    Input         any       // tool args or SQL query or Redis command
    Result        string    // "allowed" | "blocked" | "pending_approval"
    Duration      time.Duration
    BytesSent     int64
    BytesReceived int64
    ApprovedBy    string    // human who approved, if applicable
}
```

Queryable via the same MCP interface:

```json
// MCP tool for audit
{
  "name": "audit.search",
  "input": {
    "query": "blocked operations in last 24h",
    "filter": {
      "kind": "tcp_query",
      "result": "blocked",
      "since": "2026-07-04T00:00:00Z"
    }
  }
}
```

---

## Component 5: Unified Agent Surface

The agent sees a single MCP endpoint that exposes both tool-calling and TCP-aware capabilities:

### The Agent's View

```
┌─────────────────────────────────────────┐
│  Agent connects via MCP                  │
│                                         │
│  Tools available:                       │
│  ┌───────────────────────────────────┐  │
│  │ tools.search    - find any tool   │  │
│  │ tools.describe  - get schema      │  │
│  │ tools.call      - execute tool    │  │
│  │ tools.run_code  - JS in sandbox   │  │
│  │                                     │
│  │ proxies.list      - list TCP      │  │
│  │                     proxies         │  │
│  │ proxies.connect   - request TCP   │  │
│  │                     session         │  │
│  │ proxies.describe  - get proxy     │  │
│  │                     config/policy   │  │
│  │                                     │  │
│  │ audit.search     - query audit    │  │
│  │                     log             │  │
│  └───────────────────────────────────┘  │
│                                         │
│  Agent flow example:                    │
│  1. tools.search("deploy to prod")     │
│     → finds aws.work.ecs.deploy        │
│  2. proxies.describe("postgres")       │
│     → "staging DB, SELECT only"       │
│  3. proxies.connect("postgres")        │
│     → gets localhost:5432              │
│  4. psql connects to localhost:5432    │
│     → proxy handles auth + policies    │
└─────────────────────────────────────────┘
```

### TCP Connection Lifecycle via MCP

The agent requests a TCP proxy connection through MCP, creating an auditable allocation:

```
1. Agent: tools.call("proxies.connect", { name: "postgres_staging" })
2. Gateway:
   - Checks policy: "postgres_staging.connect" → allow
   - Allocates a local port (ephemeral)
   - Starts the proxy listener on localhost:54321
   - Returns: { host: "localhost", port: 54321, session_id: "sess_abc" }
3. Agent: psql -h localhost -p 54321 -d myapp
   → Proxy handles SASL auth with stored credentials
   → Proxy enforces query policies per statement
4. Agent: tools.call("proxies.disconnect", { session_id: "sess_abc" })
   → Gateway tears down the proxy, logs the session
```

For SSH, the flow is similar but the agent gets a Unix socket or TCP port to point its SSH client at:

```
1. Agent: tools.call("proxies.connect", { name: "ssh_github" })
2. Gateway:
   - Checks policy
   - Binds Unix socket /tmp/gw-ssh-github.sock
   - Returns: { socket: "/tmp/gw-ssh-github.sock" }
3. Agent: GIT_SSH_COMMAND="ssh -S /tmp/gw-ssh-github.sock" git clone git@github.com:org/repo
   → Proxy handles SSH key exchange, forwards to github.com:22
   → Proxy enforces repo allowlist
```

---

## Implementation: Extending Executor's Architecture

Rather than building from scratch, the unified gateway extends Executor's existing model:

### New Source Plugin: TCP Proxy

```typescript
// packages/plugin-tcp-proxy/src/index.ts
// A new plugin type for Executor that defines TCP proxy tools

export const tcpProxyPlugin = {
  name: "tcp-proxy",

  // Registers MCP tools for managing TCP proxies
  resolveTools: (config: TCPProxyConfig) => {
    const tools: Tool[] = [];

    for (const proxy of config.proxies) {
      tools.push({
        name: `proxies.${proxy.name}.connect`,
        description: `Open a TCP proxy connection to ${proxy.protocol}:${proxy.upstream}`,
        input: {
          type: "object",
          properties: {
            session_label: { type: "string", description: "Label for audit" },
          },
        },
        handler: async (ctx, args) => {
          // 1. Resolve credentials from secret provider
          const creds = await ctx.secrets.resolve(proxy.auth.secret_ref);
          // 2. Check policy
          await ctx.policy.evaluate(`proxies.${proxy.name}.connect`);
          // 3. Allocate port, start proxy goroutine
          const session = await startTCPProxy(proxy, creds, ctx.audit);
          return { host: "localhost", port: session.port, session_id: session.id };
        },
        // Mark as high-risk so it always requires approval
        risk: "high",
      });

      tools.push({
        name: `proxies.${proxy.name}.describe`,
        description: `Show config and policies for ${proxy.name} proxy`,
        handler: async (ctx) => {
          return {
            protocol: proxy.protocol,
            upstream: maskHost(proxy.upstream),
            policies: proxy.policies,
          };
        },
        risk: "none",
      });

      tools.push({
        name: `proxies.${proxy.name}.disconnect`,
        description: `Close a TCP proxy session`,
        input: {
          session_id: { type: "string" },
        },
        handler: async (ctx, args) => {
          await closeSession(args.session_id);
          return { closed: true };
        },
        risk: "medium",
      });
    }

    return tools;
  },
};
```

### Credential Resolution

Both MCP and TCP paths use the same secret resolution pipeline:

```go
// Gateway initialization
type Gateway struct {
    secrets *secret.Manager           // from biodome
    mcp     *MCPToolEngine
    tcp     *TCPProxyEngine
    policy  *PolicyEngine
}

func NewGateway(secrets *secret.Manager) *Gateway {
    return &Gateway{
        secrets: secrets,
        mcp:     NewMCPToolEngine(secrets),   // resolves creds on tool call
        tcp:     NewTCPProxyEngine(secrets),  // resolves creds on connect
        policy:  NewPolicyEngine(),
    }
}

// Both engines resolve credentials the same way
func (t *TCPProxyEngine) resolveCreds(ctx context.Context, ref string) (string, error) {
    // ref format: "local://my_key" or "op://vault/item/field" or "env://VAR"
    switch {
    case strings.HasPrefix(ref, "local://"):
        key := strings.TrimPrefix(ref, "local://")
        return t.secrets.Resolve(ctx, key)    // from ~/.sandbox/secrets.enc
    case strings.HasPrefix(ref, "env://"):
        return os.Getenv(strings.TrimPrefix(ref, "env://")), nil
    case strings.HasPrefix(ref, "op://"):
        // use 1Password CLI/SDK
    }
}
```

---

## Comparison to Executor.sh

| Feature                                  | Executor.sh  | Unified Gateway |
| ---------------------------------------- | ------------ | --------------- |
| HTTP API tools (OpenAPI, GraphQL)        | Yes          | Yes             |
| MCP server hosting                       | Yes          | Yes             |
| JS sandbox execution                     | Yes          | Yes             |
| Credential isolation                     | Yes          | Yes             |
| Policy engine                            | Yes          | Yes             |
| Context-efficient meta-tools             | Yes          | Yes             |
| **TCP proxy (PostgreSQL, MySQL, Redis)** | **No**       | **Yes**         |
| **SSH agent/tunnel proxy**               | **No**       | **Yes**         |
| **Protocol-level query policies**        | **No**       | **Yes**         |
| **Raw TCP forwarding**                   | **No**       | **Yes**         |
| **Unified audit (MCP + TCP)**            | **MCP only** | **Yes**         |
| **`proxies.connect` MCP lifecycle**      | **No**       | **Yes**         |

---

## Configuration: Complete Example

```yaml
# ~/.sandbox/gateway.yaml
version: 1

# ── HTTP APIs as MCP tools ──
sources:
  github:
    type: openapi
    spec: https://api.github.com/openapi.json
    connections:
      personal:
        auth:
          type: bearer
          secret_ref: local://github_personal_token
      work:
        auth:
          type: bearer
          secret_ref: op://eng/github/token

  aws:
    type: openapi
    spec: https://awssdk.com/v3/openapi.json # imported aws-sdk
    connections:
      prod:
        auth:
          type: aws_sigv4
          access_key_ref: local://aws_prod_key
          secret_key_ref: local://aws_prod_secret
          region: us-east-1
      staging:
        auth:
          type: aws_sigv4
          access_key_ref: local://aws_staging_key
          secret_key_ref: local://aws_staging_secret
          region: us-west-2

# ── TCP proxies ──
tcp_proxies:
  postgres_staging:
    bind: 127.0.0.1:0 # ephemeral port, allocated on connect
    upstream: staging-db.internal:5432
    protocol: postgresql
    auth:
      username: readonly_user
      password_ref: local://staging_db_password
      database: myapp_staging
    policies:
      connect: allow
      default_query: block
      query_allowlist:
        - "SELECT * FROM users WHERE id = $1"
        - "SELECT * FROM products WHERE sku = $1"
        - "SELECT count(*) FROM orders WHERE status = $1"
        - "SELECT * FROM orders JOIN users ON orders.user_id = users.id WHERE users.id = $1"
      rate_limit:
        max_queries_per_min: 100
        max_rows_returned: 1000

  postgres_production:
    bind: 127.0.0.1:0
    upstream: prod-db.cluster-XYZ.us-east-1.rds.amazonaws.com:5432
    protocol: postgresql
    auth:
      username: readonly_user
      password_ref: op://eng/prod-db/password
      database: myapp_prod
      ssl_mode: verify-full
    policies:
      connect: require_approval # must approve each connection
      default_query: block
      query_allowlist:
        - "SELECT * FROM products WHERE id = $1"
        - "SELECT * FROM inventory WHERE product_id = $1"
      rate_limit:
        max_queries_per_min: 30
        max_rows_returned: 500

  redis_cache:
    bind: 127.0.0.1:0
    upstream: redis-cluster.internal:6379
    protocol: redis
    auth:
      password_ref: local://redis_cache_password
    policies:
      connect: allow
      commands:
        allow:
          - GET
          - SET
          - EXISTS
          - TTL
          - EXPIRE
          - INCR
          - DECR
          - DEL
        block:
          - FLUSHALL
          - FLUSHDB
          - CONFIG
          - SLAVEOF
          - DEBUG
          - SHUTDOWN
          - SAVE
          - BGSAVE
          - BGREWRITEAOF
          - EVAL
          - EVALSHA
          - KEYS

  ssh_github:
    bind: /tmp/gw-ssh-github.sock # Unix socket
    upstream: github.com:22
    protocol: ssh
    auth:
      key_ref: local://github_deploy_key
    policies:
      allowed_repos:
        - my-org/private-repo
      allowed_commands:
        - git-upload-pack
        - git-receive-pack
      connect: allow

# ── Unified policies ──
policy:
  tools:
    github.personal.*.read: allow
    github.personal.*.write: allow
    github.work.*.read: allow
    github.work.*.write: require_approval
    github.*.billing.*: block
    aws.staging.s3.get_object: allow
    aws.staging.s3.put_object: allow
    aws.staging.s3.delete_object: block
    aws.prod.*: require_approval

# ── Secret backends (same as biodome) ──
secrets:
  backend: local
```

---

## Agent User Experience

The agent discovers and uses everything through natural language:

```
Agent: "What can I access?"

Gateway returns:
- GitHub (personal): read/write repos, issues, PRs
- GitHub (work): read repos, write needs approval
- AWS (staging): S3 read/write on staging
- AWS (prod): everything needs approval
- PostgreSQL (staging): SELECT-only on staging DB
- PostgreSQL (prod): SELECT-only, needs approval per connection
- Redis (cache): basic key-value ops, no dangerous commands
- SSH (github): deploy key for my-org/private-repo

Agent: "Show me the staging users table"

Gateway: "Opening PostgreSQL staging proxy on localhost:54321..."
Agent connects psql, runs SELECT queries, proxy enforces policy.

Agent: "Deploy the frontend to production"

Gateway stops at policy check:
→ "aws.prod.ecs.update_service requires approval"
→ Sends notification to developer
→ Developer approves via MCP channel
→ Gateway proceeds with authenticated API call
```

---

## Implementation Strategy

### Phase 1: MCP Tool Engine Only

Repurpose Executor.sh's existing tool engine. Add as a sandbox sidecar using the existing `secret.Manager` for credential resolution.

### Phase 2: TCP Proxy Layer

Implement protocol-specific proxies:

- PostgreSQL (SASL auth, query parsing via `pg_query` Go library)
- Redis (RESP3 parser, command allow/deny)
- SSH (key exchange, channel filtering via `golang.org/x/crypto/ssh`)
- Generic TCP (bandwidth-limited raw relay)

### Phase 3: Unified Policy Engine

Merge MCP tool policies and TCP proxy policies under a single evaluation engine. Add the `proxies.connect`/`proxies.disconnect` MCP lifecycle tools.

### Phase 4: Unified Audit

Extend Executor's Run model to include TCP sessions and queries. Single searchable audit across both paths.
