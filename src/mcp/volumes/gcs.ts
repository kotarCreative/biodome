import { Storage } from "@google-cloud/storage";
import { VolumeAdapter, FileInfo, VolumeConfig, resolveCredentials } from "./adapter.js";

export function createGcsAdapter(config: VolumeConfig): VolumeAdapter {
  const credentials = resolveCredentials(config.credentials);
  const storage = new Storage({
    projectId: credentials.projectNumber,
    keyFilename: credentials.serviceAccountFile,
  });
  const bucket = storage.bucket(config.bucket!);
  const prefix = config.prefix || "";

  function fullPath(path: string): string {
    return prefix + path.replace(/^\/+/, "");
  }

  function stripPrefix(key: string): string {
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  return {
    async list(path: string): Promise<FileInfo[]> {
      const full = fullPath(path);
      const [files] = await bucket.getFiles({
        prefix: full,
        delimiter: "/",
      });

      const result: FileInfo[] = [];
      const seenDirs = new Set<string>();

      for (const file of files) {
        const stripped = stripPrefix(file.name);
        if (stripped === path.replace(/^\/+/, "")) continue;

        // If the file is nested deeper than the requested path, surface the
        // immediate subdirectory instead of every nested file.
        const relative = stripped.slice(full === "" ? 0 : full.length).replace(/^\/+/, "");
        const slashIndex = relative.indexOf("/");
        if (slashIndex !== -1) {
          const dirName = relative.slice(0, slashIndex);
          if (!seenDirs.has(dirName)) {
            seenDirs.add(dirName);
            result.push({
              name: dirName,
              path: (path.replace(/\/?$/, "/") + dirName).replace(/^\/+/, ""),
              isDirectory: true,
            });
          }
          continue;
        }

        const [metadata] = await file.getMetadata();
        result.push({
          name: stripped.split("/").pop() || stripped,
          path: stripped,
          size: metadata.size ? Number(metadata.size) : undefined,
          lastModified: metadata.updated ? new Date(metadata.updated) : undefined,
          isDirectory: false,
        });
      }

      return result;
    },

    async read(path: string): Promise<Buffer> {
      const [buffer] = await bucket.file(fullPath(path)).download();
      return buffer;
    },

    async write(path: string, content: Buffer): Promise<void> {
      await bucket.file(fullPath(path)).save(content);
    },

    async stat(path: string): Promise<FileInfo> {
      const [metadata] = await bucket.file(fullPath(path)).getMetadata();
      return {
        name: path.split("/").pop() || path,
        path,
        size: metadata.size ? Number(metadata.size) : undefined,
        lastModified: metadata.updated ? new Date(metadata.updated) : undefined,
        isDirectory: false,
      };
    },
  };
}
