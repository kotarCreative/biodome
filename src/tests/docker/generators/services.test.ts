import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { generateInContainerServiceFiles } from "../../../docker/generators/services.js";

describe("generateInContainerServiceFiles", () => {
  it("initializes and starts ephemeral Postgres without a named volume", () => {
    const plan = createPlan("test");
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      environment: {
        POSTGRES_USER: "vitruvi",
        POSTGRES_PASSWORD: "devpassword",
        POSTGRES_DB: "vitruvi",
      },
      ports: [],
    });

    const files = generateInContainerServiceFiles(plan);
    expect(files["postgres.sh"]).toContain(
      'initdb" -D "$PGDATA" --auth=trust --encoding=UTF8 --locale=C',
    );
    expect(files["postgres.sh"]).toContain('postgres" -D "$PGDATA" -p 5432');
    expect(files["postgres.sh"]).toContain("max_connections=20");
    expect(files["postgres.sh"]).toContain("shared_buffers=32MB");
    expect(files["postgres.sh"]).toContain("fsync=off");
    expect(files["postgres.sh"]).toContain("autovacuum=off");
  });

  it("runs the database without privileged helpers so it can execute as its own user", () => {
    const plan = createPlan("test");
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      environment: {},
      ports: [],
    });

    const files = generateInContainerServiceFiles(plan);
    for (const content of Object.values(files)) {
      expect(content).not.toContain("su postgres");
      expect(content).not.toContain("install -d");
    }
  });

  it("binds the role password from the container environment instead of persisting it", () => {
    const plan = createPlan("test");
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      environment: {
        POSTGRES_USER: "vitruvi",
        POSTGRES_PASSWORD: "devpassword",
        POSTGRES_DB: "vitruvi",
      },
      ports: [],
    });

    const files = generateInContainerServiceFiles(plan);
    expect(files["postgres-init.sql"]).toBeUndefined();
    const init = files["postgres-init.sh"];
    expect(init).toContain(': "${POSTGRES_PASSWORD:=postgres}"');
    expect(init).toContain('-v pwd="$POSTGRES_PASSWORD"');
    expect(init).toContain("-v pwd=\"$POSTGRES_PASSWORD\" <<'SQL'");
    expect(init).toContain("SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'vitruvi', :'pwd')");
    expect(init).toContain("SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', 'vitruvi', :'pwd')");
    expect(init).toContain("'CREATE DATABASE %I OWNER %I', 'vitruvi', 'vitruvi')");
    for (const content of Object.values(files)) {
      expect(content).not.toContain("devpassword");
    }
  });
});
