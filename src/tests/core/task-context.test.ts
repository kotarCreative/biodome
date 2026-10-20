import { describe, expect, it } from "vitest";
import { TaskContextImpl } from "../../core/task-context.js";
import type { TaskSpec } from "../../core/plan.js";

const action: TaskSpec = { command: ["npm", "test"], intent: "Validate the branch" };

describe("environment action declarations", () => {
  it("needs no agent and supplies safe lifecycle defaults", () => {
    const ctx = new TaskContextImpl("qa");
    ctx.addAction(action);
    expect(ctx.getTask()).toMatchObject({
      name: "qa",
      command: ["npm", "test"],
      intent: action.intent,
      input: {},
      artifacts: [],
      timeout: "20m",
      cleanup: "never",
    });
  });

  it("preserves inputs, outputs, and execution requirements without sharing mutable input", () => {
    const ctx = new TaskContextImpl("performance");
    const input = { duration: 30, routes: ["/checkout"] };
    ctx.addAction({
      ...action,
      input,
      outputs: ["results/perf.json"],
      timeout: "5m",
      cleanup: "always",
      requiredServices: ["postgres"],
      validationCommands: [["npm", "run", "check"]],
    });
    input.routes.push("/changed");
    expect(ctx.getTask()).toMatchObject({
      input: { duration: 30, routes: ["/checkout"] },
      artifacts: ["results/perf.json"],
      cleanup: "always",
      requiredServices: ["postgres"],
      validationCommands: [["npm", "run", "check"]],
    });
  });

  it.each([{ command: [] }, { command: [""] }, { command: ["sh", "bad\0argument"] }])(
    "rejects invalid commands $command",
    ({ command }) => {
      expect(() => new TaskContextImpl("qa").addAction({ ...action, command })).toThrow();
    },
  );

  it.each(["/absolute", "../escape", "output/../escape", "bad\0file", "..\\escape", "C:\\outside"])(
    "rejects unsafe output %s",
    (output) => {
      expect(() => new TaskContextImpl("qa").addAction({ ...action, outputs: [output] })).toThrow();
    },
  );

  it.each(["", "  "])("rejects blank intent", (intent) => {
    expect(() => new TaskContextImpl("qa").addAction({ ...action, intent })).toThrow();
  });

  it.each(["forever", "0m"])("rejects invalid deadlines", (timeout) => {
    expect(() => new TaskContextImpl("qa").addAction({ ...action, timeout })).toThrow();
  });

  it.each([
    { value: undefined },
    { value: NaN },
    { value: new Date() },
    { value: () => 1 },
    { value: "a".repeat(65536) },
  ])("rejects invalid or oversized JSON input", (input) => {
    expect(() => new TaskContextImpl("qa").addAction({ ...action, input })).toThrow();
  });

  it("rejects cyclic input", () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    expect(() => new TaskContextImpl("qa").addAction({ ...action, input })).toThrow();
  });

  it("requires exactly one declaration", () => {
    const ctx = new TaskContextImpl("qa");
    expect(() => ctx.getTask()).toThrow(/did not declare an action/);
    ctx.addAction(action);
    expect(() => ctx.addAction(action)).toThrow(/called addAction twice/);
  });

  it("validates follow-up commands", () => {
    expect(() =>
      new TaskContextImpl("qa").addAction({ ...action, validationCommands: [[]] }),
    ).toThrow(/must name an executable/);
    expect(() =>
      new TaskContextImpl("qa").addAction({
        ...action,
        validationCommands: [["sh", "bad\0argument"]],
      }),
    ).toThrow(/must not contain NUL/);
  });
});
