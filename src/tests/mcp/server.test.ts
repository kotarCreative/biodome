import { describe, expect, it, vi } from "vitest";
import { authenticateBearer } from "../../mcp/auth.js";
import { decodeMcpPlan } from "../../mcp/plan.js";
import { listenOnLoopback, parseArgs } from "../../mcp/startup.js";

describe("MCP startup boundaries", () => {
  it("parses explicit startup arguments without reading process.argv", () => {
    expect(parseArgs(["--port", "4567", "--plan", "/tmp/plan.json"])).toEqual({
      port: 4567,
      planPath: "/tmp/plan.json",
    });
  });

  it("uses startup defaults when no arguments are supplied", () => {
    expect(parseArgs([])).toEqual({ port: 3001, planPath: "/workspace/.biodome-build/plan.json" });
  });

  it("rejects an invalid plan before application startup", () => {
    expect(() => decodeMcpPlan({})).toThrow();
  });

  it("binds the executable listener to loopback", () => {
    const listen = vi.fn();
    listenOnLoopback({ listen }, 4567);
    expect(listen).toHaveBeenCalledWith(4567, "127.0.0.1");
  });
});

describe("bearer authentication", () => {
  it("rejects a missing token configuration", () =>
    expect(authenticateBearer(undefined, null)).toBe(false));
  it("rejects an empty expected token", () =>
    expect(authenticateBearer("Bearer secret", "")).toBe(false));
  it("rejects a missing token", () => expect(authenticateBearer(undefined, "secret")).toBe(false));
  it("rejects malformed credentials", () =>
    expect(authenticateBearer("Basic secret", "secret")).toBe(false));
  it("rejects the wrong bearer token", () =>
    expect(authenticateBearer("Bearer wrong", "secret")).toBe(false));
  it("accepts the correct bearer token", () =>
    expect(authenticateBearer("Bearer secret", "secret")).toBe(true));
});
