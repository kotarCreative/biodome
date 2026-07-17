import { describe, it, expect } from "vitest";
import { parseServiceStatus, parseServiceStatusOutput } from "../../docker/runner.js";

describe("parseServiceStatus", () => {
  it("extracts name, state, and health from a docker compose ps json entry", () => {
    const result = parseServiceStatus({
      Service: "dev",
      State: "running",
      Health: "healthy",
      Status: "Up 2 minutes",
    });
    expect(result).toEqual({ name: "dev", state: "running", health: "healthy" });
  });

  it("returns undefined when required fields are missing", () => {
    expect(parseServiceStatus({ State: "running" })).toBeUndefined();
    expect(parseServiceStatus({ Service: "dev" })).toBeUndefined();
    expect(parseServiceStatus(null)).toBeUndefined();
    expect(parseServiceStatus("not-an-object")).toBeUndefined();
  });

  it("omits health when it is not a string", () => {
    const result = parseServiceStatus({
      Service: "redis",
      State: "running",
      Health: null,
    });
    expect(result).toEqual({ name: "redis", state: "running" });
  });
});

describe("parseServiceStatusOutput", () => {
  it("parses JSON Lines output (Docker Compose >= 2.21.0)", () => {
    const output =
      '{"Service":"dev","State":"running","Health":"healthy"}\n' +
      '{"Service":"redis","State":"running","Health":""}\n';
    expect(parseServiceStatusOutput(output)).toEqual([
      { name: "dev", state: "running", health: "healthy" },
      { name: "redis", state: "running", health: "" },
    ]);
  });

  it("parses a single JSON object on one line", () => {
    const output = '{"Service":"dev","State":"running"}';
    expect(parseServiceStatusOutput(output)).toEqual([
      { name: "dev", state: "running" },
    ]);
  });

  it("parses legacy JSON array output", () => {
    const output =
      '[{"Service":"dev","State":"running"},{"Service":"redis","State":"exited"}]';
    expect(parseServiceStatusOutput(output)).toEqual([
      { name: "dev", state: "running" },
      { name: "redis", state: "exited" },
    ]);
  });

  it("returns an empty array for empty or whitespace-only output", () => {
    expect(parseServiceStatusOutput("")).toEqual([]);
    expect(parseServiceStatusOutput("  \n  ")).toEqual([]);
  });

  it("skips blank lines between JSON records", () => {
    const output =
      '{"Service":"dev","State":"running"}\n\n{"Service":"db","State":"running"}\n';
    expect(parseServiceStatusOutput(output)).toEqual([
      { name: "dev", state: "running" },
      { name: "db", state: "running" },
    ]);
  });
});
