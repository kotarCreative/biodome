import { describe, it, expect } from "vitest";
import { TargetContextImpl } from "../../core/target-context.js";
import { ValidationError } from "../../core/errors.js";

describe("TargetContextImpl", () => {
  describe("useRuntime", () => {
    it("stores a runtime declaration and getTarget returns it", () => {
      const ctx = new TargetContextImpl("my-target");
      ctx.useRuntime("docker-compose", { port: 8080 });

      const target = ctx.getTarget();
      expect(target.name).toBe("my-target");
      expect(target.driver).toBe("docker-compose");
      expect(target.options).toEqual({ port: 8080 });
    });

    it("accepts useRuntime without options", () => {
      const ctx = new TargetContextImpl("no-options");
      ctx.useRuntime("docker-compose");

      const target = ctx.getTarget();
      expect(target.options).toEqual({});
    });

    it("throws ValidationError when called twice", () => {
      const ctx = new TargetContextImpl("dup");
      ctx.useRuntime("docker-compose");

      expect(() => ctx.useRuntime("aws-ecs")).toThrow(ValidationError);
      expect(() => ctx.useRuntime("aws-ecs")).toThrow(/called useRuntime twice/);
    });

    it("throws ValidationError for an invalid target name", () => {
      const ctx = new TargetContextImpl("-bad");
      expect(() => ctx.useRuntime("docker-compose")).toThrow(ValidationError);
      expect(() => ctx.useRuntime("docker-compose")).toThrow(/Invalid target name/);
    });

    it("throws ValidationError for an empty driver", () => {
      const ctx = new TargetContextImpl("test");
      expect(() => ctx.useRuntime("")).toThrow(ValidationError);
      expect(() => ctx.useRuntime("")).toThrow(/must be a non-empty string/);
    });

    it("throws ValidationError for non-string driver", () => {
      const ctx = new TargetContextImpl("test");
      expect(() => ctx.useRuntime(undefined as any)).toThrow(ValidationError);
      expect(() => ctx.useRuntime(null as any)).toThrow(ValidationError);
    });

    it("throws ValidationError for non-JSON-safe options", () => {
      const ctx = new TargetContextImpl("test");
      expect(() => ctx.useRuntime("docker-compose", { fn: () => {} })).toThrow(ValidationError);
      expect(() => ctx.useRuntime("docker-compose", { fn: () => {} })).toThrow(/non-JSON-safe/);
    });
  });

  describe("getTarget", () => {
    it("throws ValidationError when useRuntime was never called", () => {
      const ctx = new TargetContextImpl("never-called");
      expect(() => ctx.getTarget()).toThrow(ValidationError);
      expect(() => ctx.getTarget()).toThrow(/did not declare a runtime/);
    });
  });
});
