import { describe, it, expect } from "vitest";
import { UpstreamRegistry, parseQualified } from "../../mcp/upstream.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

function stubClient(tools: { name: string; description?: string }[]): Client {
  return {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({ tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: {} })) }),
    callTool: async (req: any) => ({ content: [{ type: "text", text: `called ${req.name}` }] }),
    ping: async () => {},
    request: async () => {},
    notification: () => {},
  } as unknown as Client;
}

describe("parseQualified", () => {
  it("splits on the first dot", () => {
    expect(parseQualified("linear.create_issue")).toEqual({ provider: "linear", tool: "create_issue" });
  });

  it("splits on first dot when tool name contains dots", () => {
    expect(parseQualified("a.b.c")).toEqual({ provider: "a", tool: "b.c" });
  });

  it("throws when there is no dot", () => {
    expect(() => parseQualified("nodot")).toThrow(/expected "provider.tool"/);
  });
});

describe("UpstreamRegistry", () => {
  it("lists catalog from connected providers", async () => {
    const registry = new UpstreamRegistry(
      [
        { name: "linear", type: "linear", mcpUrl: "http://linear", authHeader: "Authorization", authScheme: "Bearer ", token: "tok1" },
        { name: "sentry", type: "sentry", mcpUrl: "http://sentry", authHeader: "Authorization", authScheme: "Bearer ", token: "tok2" },
      ],
      async (p) => {
        if (p.name === "linear") return stubClient([{ name: "create_issue", description: "Create a Linear issue" }])
        return stubClient([{ name: "list_events", description: "List Sentry events" }])
      }
    )

    const catalog = await registry.listCatalog()
    expect(catalog).toHaveLength(2)
    expect(catalog[0].qualified).toBe("linear.create_issue")
    expect(catalog[0].provider).toBe("linear")
    expect(catalog[0].description).toBe("Create a Linear issue")
    expect(catalog[1].qualified).toBe("sentry.list_events")
    expect(catalog[1].provider).toBe("sentry")
  })

  it("describe returns a single tool", async () => {
    const registry = new UpstreamRegistry(
      [
        { name: "linear", type: "linear", mcpUrl: "http://linear", authHeader: "Authorization", authScheme: "Bearer ", token: "tok" },
      ],
      async () => stubClient([{ name: "create_issue", description: "Create" }])
    )

    const entry = await registry.describe("linear.create_issue")
    expect(entry.qualified).toBe("linear.create_issue")
    expect(entry.inputSchema).toEqual({})
  })

  it("call routes to the correct provider and tool", async () => {
    const registry = new UpstreamRegistry(
      [
        { name: "linear", type: "linear", mcpUrl: "http://linear", authHeader: "Authorization", authScheme: "Bearer ", token: "tok" },
      ],
      async () => stubClient([{ name: "create_issue" }])
    )

    const result = await registry.call("linear.create_issue", { title: "Hello" })
    expect(result).toEqual({ content: [{ type: "text", text: "called create_issue" }] })
  })

  it("captures errors from failing providers without breaking the catalog", async () => {
    const registry = new UpstreamRegistry(
      [
        { name: "good", type: "x", mcpUrl: "http://good", authHeader: "Authorization", authScheme: "Bearer ", token: "tok" },
        { name: "bad", type: "x", mcpUrl: "http://bad", authHeader: "Authorization", authScheme: "Bearer ", token: "tok" },
      ],
      async (p) => {
        if (p.name === "bad") throw new Error("connection refused")
        return stubClient([{ name: "tool1" }])
      }
    )

    const catalog = await registry.listCatalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0].provider).toBe("good")

    const errors = registry.getErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0].provider).toBe("bad")
    expect(errors[0].error).toContain("connection refused")
  })

  it("close cleans up all clients", async () => {
    let closed = false
    const registry = new UpstreamRegistry(
      [
        { name: "p1", type: "x", mcpUrl: "http://p1", authHeader: "Authorization", authScheme: "Bearer ", token: "tok" },
      ],
      async () => {
        return { close: async () => { closed = true } } as unknown as Client
      }
    )

    await registry.listCatalog()
    await registry.close()
    expect(closed).toBe(true)
  })
});
