# Security Policy

## Reporting a vulnerability

Do not open a public issue for security vulnerabilities. Email
**security@kotarcreative.dev** with:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- The version(s) of `@kotarcreative/biodome` affected.

You will receive an acknowledgment within 3 business days. We will coordinate
a fix and disclosure timeline with you and credit reporters by default
(opt out at any time).

## Scope

Biodome generates and runs development environments and ships a built-in MCP
server that can execute commands inside containers. Areas of particular
interest:

- Generated shell scripts, supervisord configs, and Compose files
  (injection via plan values).
- Secret handling: env references vs literals, redaction in events, logs,
  plans, and MCP tool output. AWS secret ARN references (`{ secretArn }`) are
  injected by the target (native ECS `secrets` field) rather than stored in
  task definitions.
- MCP server auth, request bounds, volume adapters (S3/GCS/Azure/local),
  and command execution limits.
- Third-party app-recipe loading (`biodome app add`).

## Supported versions

Only the latest released minor version receives security fixes.

## Automation

Dependency updates are monitored via Dependabot; CI runs `npm audit` on
production dependencies at the high severity level.
