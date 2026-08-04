import { describe, expect, it } from "vitest";
import { sortApplications } from "../../apps/graph.js";

describe("application dependency graph", () => {
  it("orders dependencies before their consumers", () => {
    expect(
      sortApplications([
        { name: "frontend", dependencies: ["backend"] },
        { name: "backend", dependencies: [] },
      ]),
    ).toEqual(["backend", "frontend"]);
  });
  it("reports a complete dependency cycle", () => {
    expect(() =>
      sortApplications([
        { name: "a", dependencies: ["b"] },
        { name: "b", dependencies: ["a"] },
      ]),
    ).toThrow("a -> b -> a");
  });
});
