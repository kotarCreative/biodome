# Development Roadmap for Sandbox Manager

## Overview

This document defines the scope and timeline for the sandbox manager project, breaking down the development into clear phases with specific deliverables and priorities.

> **Implementation note:** The project currently ships as a TypeScript/Node.js CLI with JavaScript-based feature files under `sandbox/`. Early drafts of this roadmap describe a Go implementation and YAML-based configuration; those sections are kept for historical context but the active codebase uses the TypeScript stack documented in `README.md` and `docs/`. Phase milestones and acceptance criteria remain valid, but language-specific details refer to the older plan.

---

## Phase 1: Core MVP (Weeks 1-6)

### Primary Goal
Build a working sandbox manager that can:
- Parse the `sandbox/` configuration directory structure
- Generate optimized Dockerfiles
- Build and run containers with services
- Execute basic lifecycle hooks

### Deliverables

#### Week 1: Config Discovery + File Parsing

**Core Components:**
1. `sandbox-cli` main entry point
2. Config file discovery and parser for the `sandbox/` directory
3. Per-file schema validation with helpful error messages
4. Simple help/usage output

**Technical Specifications:**
- Discover and parse files under the `sandbox/` directory (`config.yaml`, `env.yaml`, `services.yaml`, `hooks.yaml`, `secrets.yaml`)
- Support basic interpolation (`${LOCAL_SSH_AGENT}`, `${VARIABLE}`)
- Generate error messages that guide users toward fixes
- See `research/package-service-interface.md` for the full file structure

**Acceptance Criteria:**
- `sandbox init` creates a valid `sandbox/` directory with default files
- `sandbox config validate` passes for all files under `sandbox/`
- Invalid configs produce helpful error messages pointing to the exact file

#### Week 2: Dockerfile Generator

**Core Components:**
1. Dockerfile template system
2. Optimized layer ordering (deps before source)
3. BuildKit cache mounts for package managers
4. `.dockerignore` generation for source dirs

**Technical Specifications:**

**Layer Ordering:**
```
FROM base-image
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm npm ci
RUN --mount=type=cache,target=/root/.cache/pip poetry install
COPY . .
RUN npm run build
```

**Package Manager Integration:**
- **NPM:** `--mount=type=cache,target=/root/.npm npm ci --prefer-offline`
- **Poetry:** `RUN --mount=type=cache,target=/root/.cache/pip poetry install`
- **Pip:** `--mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt`
- **Go:** `--mount=type=cache,target=/go/pkg/mod go mod download`

**Acceptance Criteria:**
- Generated Dockerfile follows best practices
- Minimizes rebuilds (deps cached until source changes)
- Supports all package managers (apt, npm, pip, go, etc.)
- `sandbox build` produces working image

#### Week 3: Docker Compose Integration

**Core Components:**
1. Generate `docker-compose.yaml` from service definitions
2. Auto-generate service health checks
3. Network configuration and port forwarding
4. Volume mounts for persistence

**Technical Specifications:**

**Service Generation:**

```yaml
services:
  app:
    build:
      context: .
      dockerfile: .sandbox/Dockerfile
    image: sandbox-{project-name}:latest
    environment:
      DATABASE_URL: postgresql://app:devpassword@postgres:5432/mydb
      REDIS_URL: redis://:devpassword@redis:6379/0
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    volumes:
      - .:/workspace
      - node_modules:/workspace/node_modules

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: devpassword
      POSTGRES_DB: myapp
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d myapp"]
      interval: 2s
      timeout: 5s
      retries: 10
    volumes:
      - postgres_data:/var/lib/postgresql/data
```

**Acceptance Criteria:**
- `docker-compose.yml` works with `docker compose up`
- Services start in correct order with health checks
- Generated connection strings are functional
- Auto-generated `AGENTS.md` file is helpful

#### Week 4: CLI + Build Pipeline

**Core Components:**
1. CLI command structure (`build`, `up`, `down`, `exec`, `info`, `init`)
2. Docker BuildKit integration with registry cache
3. Background image pre-pull functionality
4. Logging and progress indicators

**Technical Specifications:**

**Build Pipeline:**

```bash
# Build with registry cache
docker buildx build --cache-to type=registry,ref=ghcr.io/myorg/myapp:cache,mode=max \
                   --cache-from type=registry,ref=ghcr.io/myorg/myapp:cache \
                   -t sandbox-my-app:latest .

# Push to registry
docker push sandbox-my-app:latest

# Pull at runtime
docker compose pull
```

**Pre-pull Service:**

```yaml
# Background warmup service
sandbox warmup --watch project_dir --pull images
```

**Acceptance Criteria:**
- All CLI commands work end-to-end
- Builds are fast with caching
- Images are pushable/pullable from registry
- Background warmup works (Phase 2+)

#### Week 5: Basic Hooks + Agent Integration

**Core Components:**
1. Lifecycle hook support (`build.pre`, `start.post`, `stop.pre`)
2. OpenCode MCP server generation
3. Pi extension package generation
4. AGENTS.md auto-generation

**Technical Specifications:**

**Hook Execution:**

```yaml
hooks:
  build:
    pre:
      - command: ./scripts/check-versions.sh
      - inline: echo "Building sandbox..."
    post:
      - command: ./scripts/validate-image.sh
  
  start:
    post:
      - command: ./scripts/wait-for-services.sh
      - command: ./scripts/run-migrations.sh
      - inline: |
          echo "Sandbox ready!"
          echo "Database: postgresql://app:devpassword@localhost:5432/mydb"
          echo "API: http://localhost:3000"
  
  stop:
    pre:
      - command: ./scripts/backup-data.sh
```

**AI Agent Integration:**

- **OpenCode MCP Server:** `sandbox mcp server` starts MCP server
- **Pi Extension:** Auto-generates `pi-extension.tgz`
- **AGENTS.md:** Template with connection strings and available commands

**Acceptance Criteria:**
- Hooks execute successfully
- Generated MCP server works
- AGENTS.md contains all connection info
- Pi extension can be installed

#### Week 6: Testing + Package + Documentation

**Core Components:**
1. Basic integration tests
2. Package deployment (GitHub Packages)
3. User documentation (README, CLI help)
4. Examples and templates

**Technical Specifications:**

**Package Structure:**

```
sandbox-manager/
├── src/
│   ├── cli/          # CLI entry point and commands
│   ├── core/         # Plan, context, features, languages, tools, services
│   ├── builder/      # Config discovery and plan assembly
│   ├── docker/       # Dockerfile, compose, and runner
│   └── tests/        # Unit tests
├── dist/             # Compiled JavaScript output
├── docs/             # User documentation
├── research/           # Design notes and competitive analysis
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**Testing:**

```bash
# Run tests
make test

# Integration tests
make integration

# End-to-end tests
make e2e
```

**Acceptance Criteria:**
- All tests pass
- Package can be installed via package manager
- Documentation is complete and helpful
- Examples demonstrate common use cases

---

## Phase 2: Enhanced Features (Weeks 7-10)

### Primary Goal
Add core feature gaps based on Phase 1 user feedback and competitive analysis.

### Deliverables

#### Week 7: Runtime Secrets + Service Discovery

**Core Components:**
1. Runtime secret injection (environment variables + files)
2. Service discovery auto-generation
3. Dynamic connection string generation
4. Runtime config management

**Technical Specifications:**

**Runtime Secrets:**

```yaml
runtime_secrets:
  environment_variables:
    # Auto-generated from service config
    DATABASE_URL: postgresql://app:devpassword@localhost:5432/mydb
    API_URL: http://localhost:3000
  
  file_mounts:
    # Mount secret files if needed
    - source: ./secrets/.env
      target: /workspace/.env
```

**Service Discovery:**

```yaml
# Auto-discovered service info (generated)
service_discovery:
  services:
    postgres:
      host: localhost
      port: 5432
      type: database
      credentials: generated_securely
      connection_string: postgresql://app:devpassword@localhost:5432/mydb
    redis:
      host: localhost  
      port: 6379
      type: cache
      credentials: generated_securely
      connection_string: redis://:devpassword@localhost:6379/0
```

#### Week 8: 1Password Integration

**Core Components:**
1. 1Password Service Account setup
2. 1Password CLI integration
3. 1Password Connect support
4. Automatic secrets retrieval

**Technical Specifications:**

**1Password Integration:**

```bash
# Setup 1Password for sandbox-manager
export OP_SERVICE_ACCOUNT_TOKEN="your-service-account-token"

# Initialize 1Password client
op init

# Get API key from 1Password
op get item "Production API Key" --fields password > .api_key

# In CI/CD
export OP_SERVICE_ACCOUNT_TOKEN="prod-sa-token"
export VAULT_PATH="company/dev-vault"
```

**Implementation Patterns:**

```yaml
# sandbox/secrets.yaml - 1Password secrets source
source: "1password"
vault: "company/dev-vault"
items:
  - "Production Database Password"
  - "API Authentication Key"
  - "SSH Private Key"
```

#### Week 9: Provider Abstraction

**Core Components:**
1. Provider plugin interface
2. Local Docker provider (Phase 1 baseline)
3. Fly.io provider (implementation)
4. SSH remote provider (implementation)

**Technical Specifications:**

**Provider Interface:**

```typescript
interface Provider {
  name: string;
  start(config: SandboxConfig): Promise<void>;
  stop(id: string): Promise<void>;
  exec(id: string, command: string[]): Promise<ExecResult>;
  status(id: string): Promise<Status>;
}

class FlyProvider implements Provider {
  async start(config) {
    // Use Flyctl API to create workspace
    // Configure Firecracker microVM
    // Attach volumes
    // Start services
  }
}
```

**Provider Registry:**

```yaml
providers:
  local:
    type: docker
    commands:
      start: docker compose up -d
      stop: docker compose down
      exec: docker exec
      logs: docker logs
  
  fly:
    type: fly
    commands:
      start: fly deploy --remote-only
      stop: fly apps stop
      exec: fly ssh console
      logs: fly logs
  
  ssh:
    type: remote
    commands:
      start: ssh remote start
      stop: ssh remote stop
      exec: ssh remote exec
      logs: ssh remote logs
```

#### Week 10: Advanced Hooks + Plugin System

**Core Components:**
1. Advanced hooks (`exec.pre`, `file.changed`, `session.idle`)
2. Plugin system for hooks, providers, tools
3. Git integration hooks
4. CI/CD pipeline generation

**Technical Specifications:**

**Advanced Hooks:**

```yaml
hooks:
  exec:
    pre:
      - command: ./scripts/security-check.sh
      - inline: |
          # Validate command before execution
          if [[ $1 == "rm" ]]; then
            echo "ERROR: rm command blocked"
            exit 1
          fi
    post:
      - command: ./scripts/log-command.sh
      - inline: |
          # Log all commands for audit
          echo "$(date): $1 $2 $3" >> /var/log/commands.log
  
  file:
    changed:
      - command: ./scripts/test-on-change.sh
      - command: ./scripts/lint-on-change.sh
      - command: ./scripts/run-unit-tests.sh
```

**Plugin Architecture:**

```yaml
# sandbox/config.yaml
build:
  cache:
    registry: "ghcr.io/myorg/cache"
    mode: "max"

idle:
  timeout: "30m"
  action: "stop"
```

---

## Phase 3: Enterprise Features (Weeks 11-12)

### Primary Goal
Add enterprise-grade features based on user demand and competitive analysis.

### Deliverables

#### Week 11: Advanced Security + Monitoring

**Core Components:**
1. Secrets rotation and validation
2. Audit logging and monitoring
3. Security policy enforcement
4. Access control and RBAC

**Technical Specifications:**

**Security Features:**

```yaml
security:
  secrets_rotation:
    enabled: true
    interval: "7d"
    method: "1password"
    backup: true
  
  audit_logging:
    enabled: true
    destination: "cloudwatch"
    format: "json"
    retention: "30d"
  
  policy_enforcement:
    allowed_commands: ["npm", "git", "docker", "ssh"]
    blocked_paths: ["/etc", "/root", "/home"]
    max_cpu: "80%"
    max_memory: "4GB"
```

#### Week 12: Documentation + Examples + Documentation

**Core Components:**
1. Complete API documentation
2. Code examples and tutorials
3. Architecture diagrams
4. Best practices and anti-patterns

**Acceptance Criteria:**
- All documentation is complete and accurate
- Examples cover common use cases
- API documentation is auto-generated from code
- Architecture documentation explains design decisions

---

## Tech Stack Timeline

### Phase 1 Language

**Core Language:** TypeScript (Node.js LTS) with `tsc` and `vitest`.

The CLI, plan generator, and feature execution are implemented in TypeScript. Feature files are evaluated with Node.js `vm.runInNewContext` and contribute to a shared plan object. Generated artifacts (Dockerfile, `docker-compose.yaml`, `.dockerignore`, `supervisord.conf`) are emitted as plain text.

### Phase 2 Language Extensions

**Add Node.js/TypeScript features:**
- Strongly typed plugin interfaces
- Async hook execution with proper error handling
- Parallel service startup where supported by Docker Compose

### Phase 3 Performance Optimizations

**Add Node.js/TypeScript optimizations:**
- Faster plan caching and incremental config validation
- Improved container lifecycle management
- Enhanced credential handling

---

## Dependencies and Infrastructure

### Phase 1 Dependencies

**Required:**
- Node.js LTS (matching `mise.toml`)
- npm
- Docker BuildKit
- Docker Compose
- Git

**Optional:**
- docker buildx plugin
- GitHub CLI
- `mise` for toolchain management

### Phase 2 Dependencies

**Added:**
- 1Password CLI (`op`)
- curl/wget for network operations

**Security:**
- Age encryption for secrets
- Hashicorp Vault client
- AWS SDK (optional)

### Phase 3 Dependencies

**Added:**
- Prometheus + Grafana for monitoring
- Loki/InfluxDB for logs
- Jaeger/Zipkin for tracing
- Consul/Nomad for service discovery

---

## Testing Strategy

### Phase 1 Testing

**Unit Tests:**
- Config parsing
- Dockerfile generation
- Hook execution
- Connection string generation

**Integration Tests:**
- Docker Compose lifecycle
- Service startup/shutdown
- Credential injection

**Acceptance Tests:**
- End-to-end sandbox creation
- Real Git repository cloning
- Production-like usage

### Phase 2 Testing

**Added:**
- 1Password integration tests
- Provider abstraction tests
- Advanced hook tests
- Security policy tests

### Phase 3 Testing

**Added:**
- Performance benchmarks
- Chaos engineering tests
- Security penetration testing
- Load testing

---

## Deployment and CI/CD
### Phase 1 Deployment

**Local Installation:**

```bash
# Clone and build
git clone https://github.com/sandbox-manager/sandbox-manager.git
cd sandbox-manager
npm install
npm run build
npm link

# Verify installation
sandbox --version
```

**GitHub Actions:**

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 'lts/*'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test:run
      - run: npm run build
```

### Phase 2 Deployment

**GitHub Packages / npm:**

```yaml
name: package
on:
  push:
    tags: [ 'v*.*.*' ]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 'lts/*'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Phase 3 Deployment

**Production Setup:**

```yaml
# kubernetes-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sandbox-manager
  labels:
    app: sandbox-manager
spec:
  replicas: 3
  selector:
    matchLabels:
      app: sandbox-manager
  template:
    metadata:
      labels:
        app: sandbox-manager
    spec:
      containers:
      - name: sandbox-manager
        image: ghcr.io/myorg/sandbox-manager:v1.2.3
        command: ["sandbox", "server"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: sandbox-secrets
              key: DATABASE_URL
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
```

---

## Success Metrics

### Phase 1 (MVP)

**Functional:**
- 90% of documented CLI commands work
- Generated Dockerfiles follow best practices
- Sandbox startup time < 5 seconds (cached)
- Basic hooks execute correctly

**Quality:**
- 100% test coverage
- 100% CI passing
- No security vulnerabilities in dependencies

**Adoption:**
- > 100 GitHub stars
- > 20 community contributors
- > 50 users in first month

### Phase 2

**Feature Completeness:**
- > 90% of scope items delivered
- All CLI commands documented
- All integration tests pass

**User Experience:**
- User satisfaction > 85%
- Average support tickets < 5 per week
- Documentation completion > 95%

### Phase 3

**Enterprise Readiness:**
- SOC 2 compliance
- ISO 27001 certification
- Complete observability stack
- Full audit trail

---

## Risks and Mitigation

### Identified Risks

1. **Scope Creep**:
   - **Risk:** Add too many features too early
   - **Mitigation:** Strict MVP scope, phased delivery

2. **Third-party Dependencies**:
   - **Risk:** 1Password, Fly.io, etc. can change
   - **Mitigation:** Plugin architecture, fallback mechanisms

3. **Security Vulnerabilities**:
   - **Risk:** Secret handling bugs
   - **Mitigation:** Security reviews, penetration testing

4. **Performance Issues**:
   - **Risk:** Slow builds or startup times
   - **Mitigation:** Caching, optimization, benchmarks

5. **Community Adoption**:
   - **Risk:** Low initial uptake
   - **Mitigation:** Strong documentation, examples, community engagement

### Risk Mitigation

**Development Process:**
- Weekly retrospectives and scope adjustment
- Monthly security reviews
- Automated dependency updates
- Comprehensive testing at each phase

**Community Engagement:**
- Regular blog posts and tutorials
- GitHub discussions and issues
- Discord/Slack community channels
- Virtual/physical meetups

---

## Future Directions

### Post-MVP

**Version 0.2 (6 months after v1):**
- Provider abstraction complete
- 1Password integration
- Advanced hooks
- Plugin system

**Version 0.3 (12 months after v1):**
- Enterprise security features
- Advanced observability
- Multi-cloud support
- AI-powered automation

**Version 1.0 (24 months after v1):**
- Multi-tenancy
- Advanced RBAC
- Compliance certifications
- Enterprise support

### Technology Evolution

**Target Stack:**
- Go 1.23+ with generics
- Docker + BuildKit + Compose
- Kubernetes-first design
- Cloud-native architecture
- AI/ML integration

**Future Technologies:**
- Wasm-based sandboxes
- Serverless architectures
- Edge computing
- Quantum-resistant cryptography

---

## Conclusion

The sandbox manager project combines the simplicity of Devbox, the service management of devenv, the provider model of DevPod, and the agent integration of Asylum into a single, cohesive tool.

Phase 1 establishes a solid foundation with configurable container environments and AI agent hooks. Phase 2 adds critical enterprise features and integrations. Phase 3 delivers enterprise-grade security and monitoring.

The phased approach ensures:
- Fast initial value delivery
- Predictable development velocity
- Strong security foundation
- High user satisfaction
- Community engagement and growth

This roadmap balances feature completeness with development velocity, ensuring the tool meets both user needs and technical excellence.

---

## References

- Devbox Competitive Analysis
- devenv documentation
- DevPod architecture
- Asylum features
- Dumpster Fire architecture
- Fly.io services
- 1Password Secrets Automation