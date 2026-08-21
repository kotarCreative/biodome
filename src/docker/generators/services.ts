import type { Plan, Service } from "../../core/plan.js";

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function postgresFiles(service: Service): Record<string, string> {
  const user = service.environment.POSTGRES_USER || "postgres";
  const database = service.environment.POSTGRES_DB || "postgres";
  return {
    // Runs as the package-created "postgres" system user (supervisor user=),
    // so no privileged su is required anywhere in this script.
    [`${service.name}.sh`]: [
      "#!/bin/sh",
      "set -e",
      'PG_BIN="$(pg_config --bindir)"',
      'PGDATA="/tmp/biodome-postgres"',
      'if [ ! -s "$PGDATA/PG_VERSION" ]; then',
      '  mkdir -p -m 0700 "$PGDATA"',
      `  "$PG_BIN/initdb" -D "$PGDATA" --auth=trust --encoding=UTF8 --locale=C`,
      "fi",
      "# Disposable task database: favor low resource use and fast writes over durability.",
      `exec "$PG_BIN/postgres" -D "$PGDATA" -p 5432 -c max_connections=20 -c shared_buffers=32MB -c work_mem=1MB -c maintenance_work_mem=16MB -c effective_cache_size=64MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c wal_level=minimal -c max_wal_senders=0 -c max_wal_size=32MB -c min_wal_size=32MB -c autovacuum=off -c jit=off`,
      "",
    ].join("\n"),
    // The role password is read from the container environment at run time and
    // bound through a psql variable, so it is never written into this file.
    [`${service.name}-init.sh`]: [
      "#!/bin/sh",
      "set -e",
      'PG_BIN="$(pg_config --bindir)"',
      ': "${POSTGRES_PASSWORD:=postgres}"',
      'until "$PG_BIN/pg_isready" -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1; do',
      "  sleep 1",
      "done",
      // initdb runs with --auth=trust, so psql can connect over loopback TCP
      // from the runtime identity; expanding the password here keeps every
      // byte safe inside one argument.
      `"$PG_BIN/psql" --username=postgres --dbname=postgres -v ON_ERROR_STOP=1 -v pwd="$POSTGRES_PASSWORD" <<'SQL'`,
      `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', ${sqlString(user)}, :'pwd')`,
      `WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${sqlString(user)}) \\gexec`,
      `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', ${sqlString(user)}, :'pwd')`,
      `WHERE EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${sqlString(user)}) \\gexec`,
      `SELECT format('CREATE DATABASE %I OWNER %I', ${sqlString(database)}, ${sqlString(user)})`,
      `WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${sqlString(database)}) \\gexec`,
      "SQL",
      "",
    ].join("\n"),
  };
}

function redisFiles(service: Service): Record<string, string> {
  const port = service.ports[0]?.container ?? 6379;
  return {
    // Runs as the package-created "redis" system user (supervisor user=), with
    // disposable data under /tmp: favor fast startup over durability, matching
    // the in-container Postgres posture.
    [`${service.name}.sh`]: [
      "#!/bin/sh",
      "set -e",
      "mkdir -p /tmp/biodome-redis",
      `exec redis-server --port ${port} --dir /tmp/biodome-redis --save '' --appendonly no --daemonize no`,
      "",
    ].join("\n"),
  };
}

/** Files required by services hosted inside the dev container rather than as sidecars. */
export function generateInContainerServiceFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  for (const service of plan.runtime.services) {
    if (service.type === "postgres") Object.assign(files, postgresFiles(service));
    if (service.type === "redis") Object.assign(files, redisFiles(service));
  }
  return files;
}
