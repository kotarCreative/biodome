import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { VolumeAdapter, VolumeConfig } from "../volumes/adapter.js";
import { VolumeAccessError, matchesAllowedPath } from "../volumes/adapter.js";
import { text, type ToolDefinition } from "./types.js";
export interface VolumeAdapterFactory {
  create(config: VolumeConfig): Promise<VolumeAdapter>;
  close?(): Promise<void>;
}
export interface VolumeTools {
  readonly tools: readonly ToolDefinition[];
  close(): Promise<void>;
}
const parse = (value: string) => {
  const match = /^([^/:]+):\/?(.*)$/.exec(value);
  return match ? { volume: match[1], subPath: match[2] } : null;
};
function listLimit(value: unknown, maximum: number): number {
  if (value === undefined) return maximum;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new McpError(ErrorCode.InvalidParams, "limit must be a positive integer");
  return Math.min(value, maximum);
}

function decodeBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new McpError(ErrorCode.InvalidParams, "content must be valid base64");
  return Buffer.from(value, "base64");
}
export function createVolumeTools(
  volumes: readonly VolumeConfig[],
  factory: VolumeAdapterFactory,
  limits: { readonly read: number; readonly write: number; readonly list: number },
): VolumeTools {
  const proxy = volumes.filter((volume) => volume.proxy);
  const adapters = new Map<string, Promise<VolumeAdapter>>();
  const get = (volume: VolumeConfig) => {
    const key = `${volume.type}:${volume.name}:${volume.bucket ?? volume.source ?? volume.container ?? ""}`;
    const existing = adapters.get(key);
    if (existing) return existing;
    const created = factory.create(volume);
    adapters.set(key, created);
    return created;
  };
  const find = (path: string, format: string) => {
    const parsed = parse(path);
    if (!parsed)
      throw new McpError(ErrorCode.InvalidParams, `path must be formatted as '${format}'`);
    const volume = proxy.find((candidate) => candidate.name === parsed.volume);
    if (!volume)
      throw new McpError(ErrorCode.InvalidParams, "Unknown proxy volume: " + parsed.volume);
    if (!matchesAllowedPath(parsed.subPath, volume.allowedPaths))
      throw new VolumeAccessError(`Path ${parsed.subPath} is not allowed on volume ${volume.name}`);
    return { parsed, volume };
  };
  const tools: readonly ToolDefinition[] = [
    {
      name: "list_volumes",
      description:
        "List proxy volumes exposed by the biodome MCP server. These volumes are not mounted in the dev container; access them through the file tools.",
      inputSchema: { type: "object", properties: {} },
      handler: async () =>
        text(
          JSON.stringify(
            proxy.map(({ name, type, target, readOnly, allowedPaths }) => ({
              name,
              type,
              target,
              readOnly: readOnly ?? false,
              allowedPaths: allowedPaths ?? [],
            })),
            null,
            2,
          ),
        ),
    },
    {
      name: "list_files",
      description:
        "List one page of files in a proxy volume path. Paths are formatted as 'volume-name:prefix/'.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "number" },
          cursor: { type: "string" },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const path = typeof args.path === "string" ? args.path : "";
        const { parsed, volume } = find(path, "volume-name:prefix/");
        if (args.cursor !== undefined && typeof args.cursor !== "string")
          throw new McpError(ErrorCode.InvalidParams, "cursor must be a string");
        const page = await (
          await get(volume)
        ).list(parsed.subPath, {
          limit: listLimit(args.limit, limits.list),
          cursor: args.cursor,
        });
        return text(JSON.stringify(page, null, 2));
      },
    },
    {
      name: "read_file",
      description:
        "Read a file from a proxy volume. Returns base64-encoded content. Paths are formatted as 'volume-name:path/to/file'.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: async (args) => {
        const { parsed, volume } = find(
          typeof args.path === "string" ? args.path : "",
          "volume-name:path/to/file",
        );
        const value = await (await get(volume)).read(parsed.subPath, { maxBytes: limits.read });
        return text(value.toString("base64"));
      },
    },
    {
      name: "write_file",
      description:
        "Write a file to a proxy volume. Content must be base64-encoded. Paths are formatted as 'volume-name:path/to/file'.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      handler: async (args) => {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        const { parsed, volume } = find(path, "volume-name:path/to/file");
        if (volume.readOnly) throw new VolumeAccessError(`Volume ${volume.name} is read-only`);
        const value = decodeBase64(content);
        if (value.length > limits.write)
          throw new VolumeAccessError(`Write size exceeds limit of ${limits.write} bytes`);
        await (await get(volume)).write(parsed.subPath, value);
        return text(`Wrote ${value.length} bytes to ${path}`);
      },
    },
    {
      name: "stat_file",
      description:
        "Get metadata for a file in a proxy volume. Paths are formatted as 'volume-name:path/to/file'.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: async (args) => {
        const { parsed, volume } = find(
          typeof args.path === "string" ? args.path : "",
          "volume-name:path/to/file",
        );
        const file = await (await get(volume)).stat(parsed.subPath);
        return text(
          `${file.isDirectory ? "d" : "-"} ${file.path}${file.size === undefined ? "" : ` (${file.size} bytes)`}`,
        );
      },
    },
  ];
  return {
    tools,
    async close() {
      const created = await Promise.all(adapters.values());
      await Promise.all(created.map((adapter) => adapter.close?.()));
      await factory.close?.();
    },
  };
}
