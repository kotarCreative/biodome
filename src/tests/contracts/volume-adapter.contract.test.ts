import { VolumeAccessError, type FileInfo, type VolumeAdapter } from "../../mcp/volumes/adapter.js";
import { volumeAdapterContract } from "./lib/volume-adapter.js";

function createMemoryAdapter(): VolumeAdapter {
  const files = new Map<string, Buffer>([
    ["first.txt", Buffer.from("first")],
    ["large.txt", Buffer.from("large")],
  ]);
  let closed = false;
  const info = (path: string): FileInfo => {
    const content = files.get(path);
    if (!content) throw new VolumeAccessError(`Missing file: ${path}`);
    return { name: path, path, size: content.length, isDirectory: false };
  };
  return {
    async list(_path, options) {
      if (closed) throw new VolumeAccessError("Adapter is closed");
      const paths = [...files.keys()].sort();
      const offset = options.cursor ? Number(options.cursor) : 0;
      const page = paths.slice(offset, offset + options.limit).map(info);
      const next = offset + page.length;
      return { files: page, nextCursor: next < paths.length ? String(next) : undefined };
    },
    async read(path, options) {
      if (closed) throw new VolumeAccessError("Adapter is closed");
      const content = files.get(path);
      if (!content) throw new VolumeAccessError(`Missing file: ${path}`);
      if (content.length > options.maxBytes)
        throw new VolumeAccessError("File size exceeds read limit");
      return content;
    },
    async write(path, content) {
      if (closed) throw new VolumeAccessError("Adapter is closed");
      files.set(path, content);
    },
    async stat(path) {
      if (closed) throw new VolumeAccessError("Adapter is closed");
      return info(path);
    },
    async close() {
      closed = true;
    },
  };
}

volumeAdapterContract("memory fake", createMemoryAdapter);
