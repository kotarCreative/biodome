import { describe, expect, it } from "vitest";
import { APP_RECIPE_API_VERSION, defineAppRecipe } from "../../apps/index.js";

describe("app recipes", () => {
  it("creates recipe values without expanding them", () => {
    let expanded = false;
    const basic = defineAppRecipe({
      id: "@test/basic",
      version: "1.2.3",
      apiVersion: APP_RECIPE_API_VERSION,
      expand() {
        expanded = true;
      },
    });
    const recipe = basic({ port: 3000 });
    expect(recipe).toMatchObject({
      _tag: "AppRecipe",
      id: "@test/basic",
      version: "1.2.3",
      options: { port: 3000 },
    });
    expect(expanded).toBe(false);
    expect(Object.isFrozen(recipe)).toBe(true);
  });

  it("rejects unsupported API versions", () => {
    expect(() => defineAppRecipe({ id: "@test/old", apiVersion: 2 as 1, expand() {} })).toThrow(
      "Unsupported app recipe API version",
    );
  });

  it("rejects an empty recipe version", () => {
    expect(() =>
      defineAppRecipe({
        id: "@test/invalid-version",
        version: " ",
        apiVersion: APP_RECIPE_API_VERSION,
        expand() {},
      }),
    ).toThrow("version must be a non-empty string");
  });
});
