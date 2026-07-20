import { describe, it, expect } from "vitest";
import { matchesAllowedPath } from "../../../mcp/volumes/adapter.js";

describe("matchesAllowedPath", () => {
  it("allows everything when no patterns are given", () => {
    expect(matchesAllowedPath("anything.txt", undefined)).toBe(true);
    expect(matchesAllowedPath("anything.txt", [])).toBe(true);
  });

  it("matches literal paths", () => {
    expect(matchesAllowedPath("reports/file.pdf", ["reports/file.pdf"])).toBe(true);
    expect(matchesAllowedPath("reports/file.txt", ["reports/file.pdf"])).toBe(false);
  });

  it("matches single-segment wildcards", () => {
    expect(matchesAllowedPath("reports/file.pdf", ["reports/*.pdf"])).toBe(true);
    expect(matchesAllowedPath("reports/file.txt", ["reports/*.pdf"])).toBe(false);
    expect(matchesAllowedPath("other/file.pdf", ["reports/*.pdf"])).toBe(false);
  });

  it("matches recursive wildcards", () => {
    expect(matchesAllowedPath("reports/2024/file.pdf", ["reports/**/*.pdf"])).toBe(true);
    expect(matchesAllowedPath("reports/file.pdf", ["reports/**/*.pdf"])).toBe(true);
    expect(matchesAllowedPath("reports/file.txt", ["reports/**/*.pdf"])).toBe(false);
  });

  it("matches any extension with **", () => {
    expect(matchesAllowedPath("data/nested/file.txt", ["data/**"])).toBe(true);
  });
});
