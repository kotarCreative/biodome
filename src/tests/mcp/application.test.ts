import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpApplication, type McpApplicationDependencies } from "../../mcp/application.js";
import { decodeMcpPlan } from "../../mcp/plan.js";
import type { VolumeAdapter } from "../../mcp/volumes/adapter.js";

function plan(
  options: {
    readonly allowExec?: boolean;
    readonly allowProcessControl?: boolean;
    readonly token?: string;
    readonly allowedPaths?: readonly string[];
    readonly readOnly?: boolean;
    readonly providers?: boolean;
  } = {},
) {
  return decodeMcpPlan({
    project: "test",
    languages: [],
    services: [],
    processes: [],
    endpoints: [],
    providers: options.providers ? [{ name: "issues", type: "github" }] : [],
    environment: {},
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
      token: options.token ?? null,
      allowExec: options.allowExec ?? false,
      allowProcessControl: options.allowProcessControl ?? false,
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
    const app = await createMcpApplication(plan({ token: "secret" }), dependencies(adapter));
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
    const app = await createMcpApplication(plan({ token: "secret" }), dependencies(adapter));
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
    expect(processRunner.execFile).toHaveBeenCalledWith("tail", ["-n", "10", "/tmp/worker.log"]);
    expect(processRunner.execFile).toHaveBeenCalledWith("supervisorctl", [
      "-c",
      "/workspace/.biodome-build/supervisord.conf",
      "restart",
      "worker",
    ]);
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
