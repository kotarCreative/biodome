import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readState, writeState, removeState, statePath } from "../../runtime/state.js";
import { targetBuildDir } from "../../runtime/output.js";
import { ValidationError } from "../../core/errors.js";

function tmpRoot(): string {
  return join(tmpdir(), `state-test-${randomUUID()}`);
}

describe("Deployment state", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = tmpRoot();
    mkdirSync(targetBuildDir(rootDir, "test-target"), { recursive: true });
  });

  afterEach(() => {
    import("node:fs").then((fs) => fs.rmSync(rootDir, { recursive: true, force: true }));
  });

  describe("readState", () => {
    it("returns state when all fields match", () => {
      writeState(rootDir, "test-target", {
        driver: "docker-compose",
        deploymentId: "abc-123",
        createdAt: new Date().toISOString(),
        resourceIds: { project: "abc-123" },
      });

      const state = readState(rootDir, "test-target", "abc-123", "docker-compose");
      expect(state.target).toBe("test-target");
      expect(state.driver).toBe("docker-compose");
      expect(state.deploymentId).toBe("abc-123");
      expect(state.schemaVersion).toBe(1);
    });

    it("rejects missing state file", () => {
      expect(() => readState(rootDir, "nonexistent", "abc-123", "docker-compose")).toThrow(
        ValidationError,
      );
    });

    it("rejects mismatched target", () => {
      writeState(rootDir, "test-target", {
        driver: "docker-compose",
        deploymentId: "abc-123",
        createdAt: new Date().toISOString(),
        resourceIds: { project: "abc-123" },
      });

      expect(() => readState(rootDir, "wrong-target", "abc-123", "docker-compose")).toThrow(
        ValidationError,
      );
    });

    it("rejects mismatched driver", () => {
      writeState(rootDir, "test-target", {
        driver: "docker-compose",
        deploymentId: "abc-123",
        createdAt: new Date().toISOString(),
        resourceIds: { project: "abc-123" },
      });

      expect(() => readState(rootDir, "test-target", "abc-123", "aws-ecs")).toThrow(
        ValidationError,
      );
    });

    it("rejects mismatched deployment ID", () => {
      writeState(rootDir, "test-target", {
        driver: "docker-compose",
        deploymentId: "abc-123",
        createdAt: new Date().toISOString(),
        resourceIds: { project: "abc-123" },
      });

      expect(() => readState(rootDir, "test-target", "wrong-id", "docker-compose")).toThrow(
        ValidationError,
      );
    });

    it("rejects invalid schema version", () => {
      const path = statePath(rootDir, "test-target");
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 999,
          target: "test-target",
          driver: "docker-compose",
          deploymentId: "abc-123",
          createdAt: new Date().toISOString(),
          resourceIds: {},
        }),
      );

      expect(() => readState(rootDir, "test-target", "abc-123", "docker-compose")).toThrow(
        ValidationError,
      );
    });

    it("rejects malformed JSON", () => {
      const path = statePath(rootDir, "test-target");
      writeFileSync(path, "not-json");

      expect(() => readState(rootDir, "test-target", "abc-123", "docker-compose")).toThrow();
    });

    it("rejects malformed state fields before a driver can use them", () => {
      writeFileSync(
        statePath(rootDir, "test-target"),
        JSON.stringify({
          schemaVersion: 1,
          target: "test-target",
          driver: "docker-compose",
          deploymentId: "abc-123",
          createdAt: "not-a-date",
          resourceIds: { project: 123 },
        }),
      );

      expect(() => readState(rootDir, "test-target", "abc-123", "docker-compose")).toThrow(
        /missing required fields/,
      );
    });
  });

  describe("removeState", () => {
    it("unlinks the state file", () => {
      writeState(rootDir, "test-target", {
        driver: "docker-compose",
        deploymentId: "abc-123",
        createdAt: new Date().toISOString(),
        resourceIds: { project: "abc-123" },
      });

      const path = statePath(rootDir, "test-target");
      expect(existsSync(path)).toBe(true);

      removeState(rootDir, "test-target");
      expect(existsSync(path)).toBe(false);
    });

    it("does not throw when state file does not exist", () => {
      expect(() => removeState(rootDir, "nonexistent")).not.toThrow();
    });
  });
});
