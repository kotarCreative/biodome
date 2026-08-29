import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeCliEnvironment, loadBiodomeEnv } from "../../cli/load-env.js";

describe("loadBiodomeEnv", () => {
  it("loads .biodome/.env into process.env without overwriting existing values", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "load-env-"));
    try {
      mkdirSync(join(rootDir, ".biodome"), { recursive: true });
      writeFileSync(join(rootDir, ".biodome", ".env"), "FROM_FILE=value\nALSO_SET=from-file\n");
      process.env.ALSO_SET = "from-process";
      loadBiodomeEnv(rootDir);
      expect(process.env.FROM_FILE).toBe("value");
      expect(process.env.ALSO_SET).toBe("from-process");
      delete process.env.FROM_FILE;
      delete process.env.ALSO_SET;
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does nothing when .biodome/.env is absent", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "load-env-missing-"));
    try {
      loadBiodomeEnv(rootDir);
      expect(process.env.BIODOME_LOAD_ENV_TEST).toBeUndefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("initializeCliEnvironment", () => {
  it("adds .env to .gitignore before loading the biodome environment", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "initialize-cli-env-"));
    try {
      mkdirSync(join(rootDir, ".biodome"), { recursive: true });
      writeFileSync(join(rootDir, ".biodome", ".env"), "BIODOME_INITIALIZED=value\n");

      initializeCliEnvironment(rootDir);

      expect(readFileSync(join(rootDir, ".gitignore"), "utf8")).toBe(".env\n");
      expect(process.env.BIODOME_INITIALIZED).toBe("value");
    } finally {
      delete process.env.BIODOME_INITIALIZED;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
