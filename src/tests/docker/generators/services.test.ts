import { describe, expect, it } from "vitest";
import { createPlan } from "../../../core/plan.js";
import { generateInContainerServiceFiles } from "../../../docker/generators/services.js";

describe("generateInContainerServiceFiles", () => {
  it("initializes and starts ephemeral Postgres without a named volume", () => {
    const plan = createPlan("test");
    plan.runtime.services.push({
      name: "postgres",
      type: "postgres",
      runtime: "process",
      image: "postgresql (in-container)",
      containerName: "test-postgres",
      environment: {
        POSTGRES_USER: "vitruvi",
        POSTGRES_PASSWORD: "devpassword",
        POSTGRES_DB: "vitruvi",
      },
      ports: [],
      volumes: [],
      networks: ["biodome"],
    });

    const files = generateInContainerServiceFiles(plan);
    expect(files["postgres.sh"]).toContain(
      "initdb -D $PGDATA --auth=trust --encoding=UTF8 --locale=C",
    );
    expect(files["postgres.sh"]).toContain("postgres -D $PGDATA -p 5432");
    expect(files["postgres.sh"]).toContain("max_connections=20");
    expect(files["postgres.sh"]).toContain("shared_buffers=32MB");
    expect(files["postgres.sh"]).toContain("fsync=off");
    expect(files["postgres.sh"]).toContain("autovacuum=off");
    expect(files["postgres-init.sql"]).toContain('CREATE ROLE "vitruvi"');
    expect(files["postgres-init.sql"]).toContain("CREATE DATABASE %I OWNER %I");
  });
});
