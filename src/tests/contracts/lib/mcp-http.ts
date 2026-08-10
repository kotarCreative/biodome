import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { McpApplication } from "../../../mcp/application.js";

async function mcpResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .at(-1);
  return JSON.parse(data ? data.slice("data: ".length) : body) as unknown;
}

export function mcpHttpContract(
  implementation: string,
  create: () => Promise<McpApplication>,
): void {
  describe(`${implementation} MCP HTTP contract`, () => {
    const servers: http.Server[] = [];

    afterEach(async () => {
      await Promise.all(
        servers
          .splice(0)
          .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    });

    it("keeps health public, rejects unauthenticated requests, and rejects disabled tools", async () => {
      const app = await create();
      const server = http.createServer(app.handler);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP listener");
      const endpoint = `http://127.0.0.1:${address.port}`;

      await expect(
        fetch(`${endpoint}/health`).then((response) => response.json()),
      ).resolves.toEqual({
        status: "ok",
      });
      await expect(fetch(`${endpoint}/mcp`).then((response) => response.status)).resolves.toBe(401);

      const initialize = await fetch(`${endpoint}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer contract-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      if (!sessionId) throw new Error("expected MCP session ID");

      const tools = await fetch(`${endpoint}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer contract-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      const listed = (await mcpResponse(tools)) as { result: { tools: Array<{ name: string }> } };
      expect(listed.result.tools.map((tool) => tool.name)).not.toContain("exec_command");

      const disabled = await fetch(`${endpoint}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer contract-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "exec_command", arguments: { command: "pwd" } },
        }),
      });
      const result = (await mcpResponse(disabled)) as { error?: { code: number } };
      expect(result.error?.code).toBe(-32601);
      await app.close();
    });
  });
}
