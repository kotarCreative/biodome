import { describe, expect, it } from "vitest";
import {
  assertIdentifier,
  formatDuration,
  parseDuration,
  shellQuote,
} from "../../../docker/generators/shell.js";

describe("shell helpers", () => {
  it("quotes shell arguments only when they need quoting", () => {
    expect(shellQuote("/workspace/repos/backend")).toBe("/workspace/repos/backend");
    expect(shellQuote("simple_name-1.2_3")).toBe("simple_name-1.2_3");
    expect(shellQuote("curl -f http://localhost/")).toBe("'curl -f http://localhost/'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("accepts identifiers used in paths, program names, and filenames", () => {
    expect(assertIdentifier("web")).toBe("web");
    expect(assertIdentifier("postgres-server")).toBe("postgres-server");
    expect(assertIdentifier("rclone.mount_v2")).toBe("rclone.mount_v2");
  });

  it("rejects identifiers containing shell metacharacters", () => {
    expect(() => assertIdentifier("$(id)")).toThrow(/Invalid name/);
    expect(() => assertIdentifier("a;b")).toThrow(/Invalid name/);
    expect(() => assertIdentifier("a b")).toThrow(/Invalid name/);
    expect(() => assertIdentifier("a`id`")).toThrow(/Invalid name/);
    expect(() => assertIdentifier("a|b")).toThrow(/Invalid name/);
    expect(() => assertIdentifier("-leading-dash")).toThrow(/Invalid name/);
    expect(() => assertIdentifier("a;b", "process name")).toThrow(/Invalid process name/);
  });

  it("parses durations with s/m/h/d units and defaults on absent or invalid values", () => {
    expect(parseDuration("5s", 1)).toBe(5);
    expect(parseDuration("2m", 1)).toBe(120);
    expect(parseDuration("1h", 1)).toBe(3600);
    expect(parseDuration("1d", 1)).toBe(86400);
    expect(parseDuration("1.5s", 1)).toBe(1.5);
    expect(parseDuration(undefined, 3)).toBe(3);
    expect(parseDuration("bogus", 7)).toBe(7);
  });

  it("formats durations using the largest whole unit", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(90)).toBe("90s");
    expect(formatDuration(7)).toBe("7s");
  });
});
