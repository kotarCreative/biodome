import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpApplication, type McpApplicationDependencies } from "../../mcp/application.js";
import { decodeMcpPlan } from "../../mcp/plan.js";
import type { VolumeAdapter } from "../../mcp/volumes/adapter.js";

function plan(
  options: {
    readonly allowExec?: boolean;
    readonly allowProcessControl?: boolean;
    readonly token?: { env: string } | null;
    readonly allowedPaths?: readonly string[];
    readonly readOnly?: boolean;
    readonly providers?: boolean;
    readonly commandTimeoutMs?: number;
    readonly environment?: Record<string, string>;
    readonly serviceConnection?: unknown;
  } = {},
) {
  return decodeMcpPlan({
    project: "test",
    languages: [],
    services: options.serviceConnection
      ? [
          {
            name: "db",
            type: "postgres",
            image: "postgres:17",
            ports: [{ host: 5432, container: 5432 }],
            connection: options.serviceConnection,
          },
        ]
      : [],
    processes: [],
    endpoints: [],
    providers: options.providers ? [{ name: "issues", type: "github" }] : [],
    environment: options.environment ?? {},
    envVars: [],
    repos: [],
    volumes: [
      {
        name: "files",
        type: "local",
        target: "/files",
        source: "/tmp/files",
        proxy: true,
        allowedPaths: options.allowedPaths ? [...options.allowedPaths] : ["**"],
        readOnly: options.readOnly,
      },
    ],
    mcp: {
      enabled: options.token !== null && options.token !== undefined,
      token: options.token ?? null,
      allowExec: options.allowExec ?? false,
      allowProcessControl: options.allowProcessControl ?? false,
      commandTimeoutMs: options.commandTimeoutMs,
      maxReadBytes: 1024,
      maxWriteBytes: 1024,
      maxListEntries: 100,
    },
  });
}

function resultText(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return result.content[0]?.text ?? "";
}

function dependencies(adapter: VolumeAdapter): McpApplicationDependencies & {
  readonly closed: { providers: boolean; adapters: boolean; events: boolean };
} {
  const closed = { providers: false, adapters: false, events: false };
  return {
    closed,
    volumeAdapters: {
      create: async () => adapter,
      close: async () => {
        closed.adapters = true;
      },
    },
    providers: {
      listCatalog: async () => [],
      describe: async () => {
        throw new Error("not used");
      },
      call: async () => ({}),
      getErrors: () => [],
      close: async () => {
        closed.providers = true;
      },
    },
    processRunner: {
      exec: async () => ({ stdout: "executed", stderr: "" }),
      execFile: async () => ({ stdout: "output", stderr: "" }),
    },
    probeService: async () => true,
    events: {
      write: async () => {},
      close: async () => {
        closed.events = true;
      },
    },
    uuid: () => "test-id",
    now: () => new Date(0),
  };
}

const adapter: VolumeAdapter = {
  list: async () => ({ files: [{ name: "one", path: "one.txt", size: 3, isDirectory: false }] }),
  read: async () => Buffer.from("abc"),
  write: async () => {},
  stat: async () => ({ name: "one", path: "one.txt", size: 3, isDirectory: false }),
};

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("MCP application", () => {
  it("keeps health constant and unauthenticated", async () => {
    const app = await createMcpApplication(
      plan({ token: { env: "MCP_TOKEN" } }),
      dependencies(adapter),
      { MCP_TOKEN: "secret" },
    );
    const server = http.createServer(app.handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects malformed and wrong transport credentials", async () => {
    const app = await createMcpApplication(
      plan({ token: { env: "MCP_TOKEN" } }),
      dependencies(adapter),
      { MCP_TOKEN: "secret" },
    );
    const server = http.createServer(app.handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener");
    for (const authorization of ["Basic secret", "Bearer wrong"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        headers: { authorization },
      });
      expect(response.status).toBe(401);
    }
  });

  it("rejects declared request bodies above the size cap with a JSON-RPC 413", async () => {
    const app = await createMcpApplication(
      plan({ token: { env: "MCP_TOKEN" } }),
      { ...dependencies(adapter), maxRequestBodyBytes: 16 },
      { MCP_TOKEN: "secret" },
    );
    const server = http.createServer(app.handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      // Raw request so the declared Content-Length exceeds the cap regardless of body.
      const request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "/mcp",
          headers: {
            authorization: "Bearer secret",
            "content-type": "application/json",
            "content-length": String(1024),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end("{}");
    });
    expect(status).toBe(413);
  });

  it("aborts chunked request bodies that exceed the size cap mid-stream", async () => {
    const app = await createMcpApplication(
      plan({ token: { env: "MCP_TOKEN" } }),
      { ...dependencies(adapter), maxRequestBodyBytes: 16 },
      { MCP_TOKEN: "secret" },
    );
    const server = http.createServer(app.handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP listener");
    const outcome = await new Promise<{ status?: number; error?: Error }>((resolve) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "/mcp",
          headers: {
            authorization: "Bearer secret",
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve({ status: response.statusCode }));
        },
      );
      request.on("error", (error: Error) => resolve({ error }));
      request.write(JSON.stringify({ jsonrpc: "2.0", method: "x".repeat(16) }));
      request.end(JSON.stringify({ more: "payload pushing past the cap" }));
    });
    if (outcome.error) {
      expect(outcome.error.message).toMatch(/ECONNRESET|socket hang up/);
    } else {
      expect(outcome.status).toBe(413);
    }
  });

  it("fails startup when MCP is enabled but the token variable is unset", async () => {
    await expect(
      createMcpApplication(plan({ token: { env: "MCP_TOKEN" } }), dependencies(adapter), {}),
    ).rejects.toThrow("MCP_TOKEN is missing or empty");
  });

  it("fails startup when MCP is enabled but the token variable is empty", async () => {
    await expect(
      createMcpApplication(plan({ token: { env: "MCP_TOKEN" } }), dependencies(adapter), {
        MCP_TOKEN: "",
      }),
    ).rejects.toThrow("MCP_TOKEN is missing or empty");
  });

  it("fails startup when the token variable resolves to an unresolved placeholder", async () => {
    await expect(
      createMcpApplication(plan({ token: { env: "MCP_TOKEN" } }), dependencies(adapter), {
        MCP_TOKEN: "${OTHER_VAR}",
      }),
    ).rejects.toThrow("unresolved placeholder");
  });

  it("redacts secrets from get_sandbox_info output", async () => {
    const app = await createMcpApplication(
      plan({
        environment: {
          DB_PASSWORD: "hunter2",
          DATABASE_URL: "postgres://user:pass@db:5432/app",
          PUBLIC_SETTING: "visible",
        },
        serviceConnection: { url: "postgres://admin:hunter2@db:5432/app" },
      }),
      dependencies(adapter),
    );
    const info = resultText(await app.invoke("get_sandbox_info"));
    expect(info).not.toContain("hunter2");
    expect(info).not.toContain("user:pass");
    expect(info).toContain("***REDACTED***");
    expect(info).toContain("visible");
    await app.close();
  });

  it("records exec_command metadata without persisting command text", async () => {
    const written: { type: string; data: Record<string, unknown> }[] = [];
    const deps = dependencies(adapter);
    const app = await createMcpApplication(plan({ allowExec: true }), {
      ...deps,
      events: {
        write: async (type, data) => {
          written.push({ type, data: { ...data } });
        },
        close: deps.events.close,
      },
    });
    const command =
      "psql --password=sekret && npm config set //registry/:_authToken=npm-token && curl -H X-Api-Key:api-key https://h";
    await app.invoke("exec_command", { command });
    const audit = written.find((event) => event.type === "tool.exec");
    expect(audit).toBeDefined();
    expect(audit?.data).toEqual({ commandBytes: Buffer.byteLength(command), timeoutMs: 30000 });
    expect(audit?.data).not.toHaveProperty("command");
    expect(JSON.stringify(audit)).not.toContain("sekret");
    expect(JSON.stringify(audit)).not.toContain("npm-token");
    expect(JSON.stringify(audit)).not.toContain("api-key");
    await app.close();
  });

  it("returns a generic internal error and keeps details server-side", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = await createMcpApplication(
        plan(),
        dependencies({
          ...adapter,
          read: async () => {
            throw new Error("boom with Authorization: Bearer sekret");
          },
        }),
      );
      const failure = await app.invoke("read_file", { path: "files:one.txt" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: -32603 });
      expect((failure as { message: string }).message).not.toContain("sekret");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Authorization: Bearer ***REDACTED***"),
      );
      await app.close();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("omits disabled tools and rejects direct calls", async () => {
    const app = await createMcpApplication(plan(), dependencies(adapter));
    expect(app.tools.map((tool) => tool.name)).not.toContain("exec_command");
    await expect(app.invoke("exec_command", { command: "pwd" })).rejects.toMatchObject({
      code: -32601,
    });
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("routes process logs, restart, and command execution through its runner", async () => {
    const processRunner = {
      exec: vi.fn(async () => ({ stdout: "command output", stderr: "" })),
      execFile: vi.fn(async () => ({ stdout: "file output", stderr: "" })),
    };
    const deps = dependencies(adapter);
    const app = await createMcpApplication(plan({ allowExec: true, allowProcessControl: true }), {
      ...deps,
      processRunner,
    });
    expect(resultText(await app.invoke("get_logs", { process_name: "worker", lines: 10 }))).toBe(
      "file output",
    );
    expect(resultText(await app.invoke("restart_process", { process_name: "worker" }))).toBe(
      "file output",
    );
    expect(resultText(await app.invoke("exec_command", { command: "pwd" }))).toBe("command output");
    expect(processRunner.execFile).toHaveBeenCalledWith("tail", [
      "-n",
      "10",
      "/workspace/.biodome-build/logs/worker.log",
    ]);
    expect(processRunner.execFile).toHaveBeenCalledWith("supervisorctl", [
      "-c",
      "/workspace/.biodome-build/supervisord.conf",
      "restart",
      "worker",
    ]);
    await app.close();
  });

  it("caps exec_command timeout at the configured command limit", async () => {
    const processRunner = {
      exec: vi.fn(async () => ({ stdout: "command output", stderr: "" })),
      execFile: vi.fn(async () => ({ stdout: "file output", stderr: "" })),
    };
    const app = await createMcpApplication(plan({ allowExec: true, commandTimeoutMs: 5000 }), {
      ...dependencies(adapter),
      processRunner,
    });

    await app.invoke("exec_command", { command: "pwd", timeout: 30 });
    expect(processRunner.exec).toHaveBeenCalledWith("pwd", { cwd: "/workspace", timeoutMs: 5000 });
    await app.close();
  });

  it("does not advertise provider tools when the plan declares no providers", async () => {
    const app = await createMcpApplication(plan(), dependencies(adapter));
    expect(app.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "get_providers",
        "provider_search",
        "provider_describe",
        "provider_execute",
      ]),
    );
    await expect(app.invoke("provider_search", { query: "issue" })).rejects.toMatchObject({
      code: -32601,
    });
    await app.close();
  });

  it("advertises provider tools when the plan declares a provider", async () => {
    const app = await createMcpApplication(plan({ providers: true }), dependencies(adapter));
    expect(app.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_providers",
        "provider_search",
        "provider_describe",
        "provider_execute",
      ]),
    );
    expect(resultText(await app.invoke("get_providers"))).toContain('"name": "issues"');
    await app.close();
  });

  it("routes volume list, read, write, and stat through its adapter", async () => {
    const volume = {
      list: vi.fn(adapter.list),
      read: vi.fn(adapter.read),
      write: vi.fn(adapter.write),
      stat: vi.fn(adapter.stat),
    };
    const app = await createMcpApplication(plan(), dependencies(volume));
    await app.invoke("list_files", { path: "files:reports" });
    expect(resultText(await app.invoke("read_file", { path: "files:one.txt" }))).toBe("YWJj");
    await app.invoke("write_file", { path: "files:new.txt", content: "eA==" });
    await app.invoke("stat_file", { path: "files:one.txt" });
    expect(volume.list).toHaveBeenCalledWith("reports", { limit: 100, cursor: undefined });
    expect(volume.read).toHaveBeenCalledWith("one.txt", { maxBytes: 1024 });
    expect(volume.write).toHaveBeenCalledWith("new.txt", Buffer.from("x"));
    expect(volume.stat).toHaveBeenCalledWith("one.txt");
    await app.close();
  });

  it("clamps list limits, keeps access checks before I/O, and closes a reused adapter once", async () => {
    const close = vi.fn(async () => {});
    const volume = { ...adapter, list: vi.fn(adapter.list), close };
    const create = vi.fn(async () => volume);
    const deps = dependencies(volume);
    const app = await createMcpApplication(plan({ allowedPaths: ["reports/**"] }), {
      ...deps,
      volumeAdapters: { create },
    });
    await app.invoke("list_files", { path: "files:reports", limit: 999 });
    await app.invoke("read_file", { path: "files:reports/one.txt" });
    expect(create).toHaveBeenCalledOnce();
    expect(volume.list).toHaveBeenCalledWith("reports", { limit: 100, cursor: undefined });
    await expect(app.invoke("list_files", { path: "files:private" })).rejects.toMatchObject({
      code: -32602,
    });
    expect(volume.list).toHaveBeenCalledOnce();
    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("validates base64 and applies write limits to decoded bytes before provider I/O", async () => {
    const write = vi.fn(adapter.write);
    const app = await createMcpApplication(plan(), dependencies({ ...adapter, write }));
    await expect(
      app.invoke("write_file", { path: "files:new.txt", content: "!!!" }),
    ).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      app.invoke("write_file", {
        path: "files:new.txt",
        content: Buffer.alloc(1025).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(write).not.toHaveBeenCalled();
    await app.close();
  });

  it("closes provider, adapter, and event resources", async () => {
    const deps = dependencies(adapter);
    const app = await createMcpApplication(plan(), deps);
    await app.close();
    expect(deps.closed).toEqual({ providers: true, adapters: true, events: true });
  });
});
