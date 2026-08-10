import { describe, it, expect, vi } from "vitest";
import { UpstreamRegistry, parseQualified } from "../../mcp/upstream.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

function stubClient(tools: { name: string; description?: string }[]): Client {
  return {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: {},
      })),
    }),
    callTool: async (req: any) => ({ content: [{ type: "text", text: `called ${req.name}` }] }),
    ping: async () => {},
    request: async () => {},
    notification: () => {},
  } as unknown as Client;
}

function provider(
  name: string,
  token = "tok",
): {
  name: string;
  type: string;
  mcpUrl: string;
  authHeader: string;
  authScheme: string;
  token: string;
} {
  return {
    name,
    type: "test",
    mcpUrl: `http://${name}`,
    authHeader: "Authorization",
    authScheme: "Bearer ",
    token,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("parseQualified", () => {
  it("splits on the first dot", () => {
    expect(parseQualified("linear.create_issue")).toEqual({
      provider: "linear",
      tool: "create_issue",
    });
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
        {
          name: "linear",
          type: "linear",
          mcpUrl: "http://linear",
          authHeader: "Authorization",
          authScheme: "Bearer ",
          token: "tok1",
        },
        {
          name: "sentry",
          type: "sentry",
          mcpUrl: "http://sentry",
          authHeader: "Authorization",
          authScheme: "Bearer ",
          token: "tok2",
        },
      ],
      async (p) => {
        if (p.name === "linear")
          return stubClient([{ name: "create_issue", description: "Create a Linear issue" }]);
        return stubClient([{ name: "list_events", description: "List Sentry events" }]);
      },
    );

    const catalog = await registry.listCatalog();
    expect(catalog).toHaveLength(2);
    expect(catalog[0].qualified).toBe("linear.create_issue");
    expect(catalog[0].provider).toBe("linear");
    expect(catalog[0].description).toBe("Create a Linear issue");
    expect(catalog[1].qualified).toBe("sentry.list_events");
    expect(catalog[1].provider).toBe("sentry");
  });

  it("describe returns a single tool", async () => {
    const registry = new UpstreamRegistry(
      [
        {
          name: "linear",
          type: "linear",
          mcpUrl: "http://linear",
          authHeader: "Authorization",
          authScheme: "Bearer ",
          token: "tok",
        },
      ],
      async () => stubClient([{ name: "create_issue", description: "Create" }]),
    );

    const entry = await registry.describe("linear.create_issue");
    expect(entry.qualified).toBe("linear.create_issue");
    expect(entry.inputSchema).toEqual({});
  });

  it("call routes to the correct provider and tool", async () => {
    const registry = new UpstreamRegistry(
      [
        {
          name: "linear",
          type: "linear",
          mcpUrl: "http://linear",
          authHeader: "Authorization",
          authScheme: "Bearer ",
          token: "tok",
        },
      ],
      async () => stubClient([{ name: "create_issue" }]),
    );

    const result = await registry.call("linear.create_issue", { title: "Hello" });
    expect(result).toEqual({ content: [{ type: "text", text: "called create_issue" }] });
  });

  it("captures errors from failing providers without breaking the catalog", async () => {
    const registry = new UpstreamRegistry(
      [
        {
          name: "good",
          type: "x",
          mcpUrl: "http://good",
          authHeader: "Authorization",
          authScheme: "Bearer ",
          token: "tok",
        },
        {
          name: "bad",
          type: "x",
          mcpUrl: "http://bad",
          authHeader: "Authorization",
          authScheme: "Bearer ",
          token: "tok",
        },
      ],
      async (p) => {
        if (p.name === "bad") throw new Error("connection refused");
        return stubClient([{ name: "tool1" }]);
      },
    );

    const catalog = await registry.listCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].provider).toBe("good");

    const errors = registry.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].provider).toBe("bad");
    expect(errors[0].error).toContain("connection refused");
  });

  it("close cleans up all clients", async () => {
    let closed = false;
    const registry = new UpstreamRegistry(
      [
        {
          name: "p1",
          type: "x",
          mcpUrl: "http://p1",
          authHeader: "Authorization",
          authScheme: "Bearer ",
          token: "tok",
        },
      ],
      async () => {
        return {
          close: async () => {
            closed = true;
          },
        } as unknown as Client;
      },
    );

    await registry.listCatalog();
    await registry.close();
    expect(closed).toBe(true);
  });

  it("shares one initial refresh and never returns a partial catalog", async () => {
    const pending = deferred<{ tools: { name: string; inputSchema: {} }[] }>();
    const listTools = vi.fn(async () => pending.promise);
    const registry = new UpstreamRegistry(
      [provider("one")],
      async () => ({ listTools, close: async () => {} }) as unknown as Client,
    );

    const first = registry.listCatalog();
    const second = registry.listCatalog();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listTools).toHaveBeenCalledTimes(1);
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve({ tools: [{ name: "late", inputSchema: {} }] });
    await expect(first).resolves.toEqual(await second);
  });

  it("uses bounded concurrency and deterministic catalog ordering", async () => {
    let active = 0;
    let maximum = 0;
    const registry = new UpstreamRegistry(
      [provider("z"), provider("a"), provider("m")],
      async (current) =>
        ({
          listTools: async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, current.name === "z" ? 15 : 5));
            active -= 1;
            return { tools: [{ name: current.name === "a" ? "zeta" : "alpha", inputSchema: {} }] };
          },
          close: async () => {},
        }) as unknown as Client,
      { catalogConcurrency: 2 },
    );

    await expect(registry.listCatalog()).resolves.toMatchObject([
      { qualified: "a.zeta" },
      { qualified: "m.alpha" },
      { qualified: "z.alpha" },
    ]);
    expect(maximum).toBe(2);
  });

  it("keeps healthy catalogs when another provider times out and redacts credentials", async () => {
    vi.useFakeTimers();
    try {
      const registry = new UpstreamRegistry(
        [provider("slow", "test-token"), provider("good")],
        async (current) =>
          current.name === "slow"
            ? ({
                listTools: async () => new Promise(() => {}),
                close: async () => {},
              } as unknown as Client)
            : stubClient([{ name: "available" }]),
        { requestTimeoutMs: 10, catalogConcurrency: 2 },
      );
      const catalog = registry.listCatalog();
      await vi.advanceTimersByTimeAsync(10);
      await expect(catalog).resolves.toMatchObject([{ qualified: "good.available" }]);
      expect(registry.getErrors()).toEqual([
        { provider: "slow", error: 'Provider "slow" request timed out' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes failed connection promises so later requests can reconnect", async () => {
    let connections = 0;
    const registry = new UpstreamRegistry([provider("one")], async () => {
      connections += 1;
      if (connections === 1) throw new Error("Authorization: Bearer test-token");
      return stubClient([{ name: "ready" }]);
    });

    await registry.listCatalog();
    await expect(registry.describe("one.ready")).resolves.toMatchObject({ qualified: "one.ready" });
    expect(connections).toBe(2);
    expect(registry.getErrors()[0].error).not.toContain("test-token");
    expect(registry.getErrors()[0].error).not.toContain("Bearer");
  });

  it("does not retry provider execution after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const callTool = vi.fn(async () => new Promise(() => {}));
      const registry = new UpstreamRegistry(
        [provider("one")],
        async () => ({ callTool, close: async () => {} }) as unknown as Client,
        { requestTimeoutMs: 10 },
      );
      const call = registry.call("one.action", {});
      const rejected = expect(call).rejects.toThrow('Provider "one" request timed out');
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
