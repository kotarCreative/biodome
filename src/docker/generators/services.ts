import type { Plan, Service } from "../../core/plan.js";

function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function postgresFiles(service: Service): Record<string, string> {
  const user = service.environment.POSTGRES_USER || "postgres";
  const password = service.environment.POSTGRES_PASSWORD || "postgres";
  const database = service.environment.POSTGRES_DB || "postgres";
  return {
    [`${service.name}.sh`]: [
      "#!/bin/sh",
      "set -e",
      'PG_BIN="$(pg_config --bindir)"',
      'PGDATA="/tmp/biodome-postgres"',
      'if [ ! -s "$PGDATA/PG_VERSION" ]; then',
      '  install -d -m 0700 -o postgres -g postgres "$PGDATA"',
      '  su postgres -s /bin/sh -c "$PG_BIN/initdb -D $PGDATA --auth=trust --encoding=UTF8 --locale=C"',
      "fi",
      "# Disposable task database: favor low resource use and fast writes over durability.",
      'exec su postgres -s /bin/sh -c "$PG_BIN/postgres -D $PGDATA -p 5432 -c max_connections=20 -c shared_buffers=32MB -c work_mem=1MB -c maintenance_work_mem=16MB -c effective_cache_size=64MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c wal_level=minimal -c max_wal_senders=0 -c max_wal_size=32MB -c min_wal_size=32MB -c autovacuum=off -c jit=off"',
      "",
    ].join("\n"),
    [`${service.name}-init.sh`]: [
      "#!/bin/sh",
      "set -e",
      'PG_BIN="$(pg_config --bindir)"',
      'until su postgres -s /bin/sh -c "$PG_BIN/pg_isready -h 127.0.0.1 -p 5432 -U postgres" >/dev/null 2>&1; do',
      "  sleep 1",
      "done",
      'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      `su postgres -s /bin/sh -c "$PG_BIN/psql --username=postgres --dbname=postgres -v ON_ERROR_STOP=1 -f $SCRIPT_DIR/${service.name}-init.sql"`,
      "",
    ].join("\n"),
    [`${service.name}-init.sql`]: [
      "DO $$",
      "BEGIN",
      `  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${sqlString(user)}) THEN`,
      `    CREATE ROLE ${sqlIdentifier(user)} LOGIN PASSWORD ${sqlString(password)};`,
      "  ELSE",
      `    ALTER ROLE ${sqlIdentifier(user)} LOGIN PASSWORD ${sqlString(password)};`,
      "  END IF;",
      "END",
      "$$;",
      "",
      `SELECT format('CREATE DATABASE %I OWNER %I', ${sqlString(database)}, ${sqlString(user)})`,
      `WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${sqlString(database)}) \\gexec`,
      "",
    ].join("\n"),
  };
}

/** Files required by services hosted inside the dev container rather than as sidecars. */
export function generateInContainerServiceFiles(plan: Plan): Record<string, string> {
  const files: Record<string, string> = {};
  for (const service of plan.runtime.services) {
    if (service.runtime === "process" && service.type === "postgres") {
      Object.assign(files, postgresFiles(service));
    }
  }
  return files;
}
