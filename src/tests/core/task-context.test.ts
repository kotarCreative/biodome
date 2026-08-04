import { describe, it, expect } from "vitest";
import { TaskContextImpl } from "../../core/task-context.js";
import { ValidationError } from "../../core/errors.js";

describe("TaskContextImpl", () => {
  describe("addTask", () => {
    it("stores a task with all fields and getTask returns the merged result", () => {
      const ctx = new TaskContextImpl("review-pr");
      ctx.addTask({
        harness: "opencode",
        prompt: "Review the PR",
        artifacts: ["output/review.md"],
        timeout: "10m",
        cleanup: "always",
      });

      const task = ctx.getTask();
      expect(task.name).toBe("review-pr");
      expect(task.harness).toBe("opencode");
      expect(task.prompt).toBe("Review the PR");
      expect(task.artifacts).toEqual(["output/review.md"]);
      expect(task.timeout).toBe("10m");
      expect(task.cleanup).toBe("always");
    });

    it("preserves portable orchestration requirements", () => {
      const ctx = new TaskContextImpl("review-pr");
      ctx.addTask({
        harness: "opencode",
        prompt: "Review the PR",
        artifacts: [],
        timeout: "10m",
        cleanup: "always",
        requiredServices: ["postgres"],
        capabilities: [{ capability: "network.policy", level: "preferred" }],
        resources: { cpu: 2, memoryMiB: 4096 },
        network: { mode: "egress", allow: ["api.github.com:443"] },
        workspace: { strategy: "clone", ref: "main" },
        validationCommands: [["npm", "test"]],
      });

      expect(ctx.getTask()).toMatchObject({
        requiredServices: ["postgres"],
        resources: { cpu: 2, memoryMiB: 4096 },
        workspace: { strategy: "clone", ref: "main" },
        validationCommands: [["npm", "test"]],
      });
    });

    it("accepts empty artifact list", () => {
      const ctx = new TaskContextImpl("test");
      ctx.addTask({
        harness: "bash",
        prompt: "run",
        artifacts: [],
        timeout: "20m",
        cleanup: "never",
      });

      expect(ctx.getTask().artifacts).toEqual([]);
    });

    it("throws ValidationError when called twice", () => {
      const ctx = new TaskContextImpl("dup");
      ctx.addTask({
        harness: "bash",
        prompt: "first",
        artifacts: [],
        timeout: "10m",
        cleanup: "never",
      });

      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "second",
          artifacts: [],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(ValidationError);
      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "second",
          artifacts: [],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(/called addTask twice/);
    });

    it("throws ValidationError when harness is empty", () => {
      const ctx = new TaskContextImpl("test");
      expect(() =>
        ctx.addTask({
          harness: "",
          prompt: "x",
          artifacts: [],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(ValidationError);
      expect(() =>
        ctx.addTask({
          harness: "",
          prompt: "x",
          artifacts: [],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(/harness is required/);
    });

    it("throws ValidationError when prompt is empty", () => {
      const ctx = new TaskContextImpl("test");
      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "",
          artifacts: [],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(ValidationError);
      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "",
          artifacts: [],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(/prompt is required/);
    });

    it("throws ValidationError on absolute artifact path", () => {
      const ctx = new TaskContextImpl("test");
      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "x",
          artifacts: ["/absolute/path"],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError on .. artifact path segment", () => {
      const ctx = new TaskContextImpl("test");
      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "x",
          artifacts: ["output/../secret"],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError on NUL byte in artifact path", () => {
      const ctx = new TaskContextImpl("test");
      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "x",
          artifacts: ["good\0bad"],
          timeout: "10m",
          cleanup: "never",
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError on invalid timeout format", () => {
      const ctx = new TaskContextImpl("test");
      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "x",
          artifacts: [],
          timeout: "forever",
          cleanup: "never",
        }),
      ).toThrow(ValidationError);
    });

    it("throws ValidationError on non-positive timeout", () => {
      const ctx = new TaskContextImpl("test");
      expect(() =>
        ctx.addTask({
          harness: "bash",
          prompt: "x",
          artifacts: [],
          timeout: "0m",
          cleanup: "never",
        }),
      ).toThrow(ValidationError);
    });
  });

  describe("getTask", () => {
    it("throws ValidationError when addTask was never called", () => {
      const ctx = new TaskContextImpl("never-called");
      expect(() => ctx.getTask()).toThrow(ValidationError);
      expect(() => ctx.getTask()).toThrow(/did not declare a task/);
    });
  });
});
