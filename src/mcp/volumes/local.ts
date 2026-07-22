import { promises as fs } from "node:fs";
import { resolve, join, sep } from "node:path";
import { VolumeAdapter, FileInfo, VolumeConfig, VolumeAccessError } from "./adapter.js";

const PROJECT_ROOT = "/workspace";

function resolveRoot(config: VolumeConfig): string {
  if (!config.source) {
    throw new VolumeAccessError(`Local proxy volume ${config.name} requires a source path`);
  }
  if (config.source.startsWith("/")) {
    return config.source;
  }
  return join(PROJECT_ROOT, config.source);
}

async function resolvePath(config: VolumeConfig, userPath: string): Promise<string> {
  const root = resolveRoot(config);
  const resolvedRoot = resolve(root);

  if (userPath.startsWith("/")) {
    throw new VolumeAccessError(`Absolute paths are not allowed: ${userPath}`);
  }

  const candidate = resolve(resolvedRoot, userPath);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep)) {
    throw new VolumeAccessError(`Path traversal detected: ${userPath}`);
  }

  return candidate;
}

async function resolveExistingPath(config: VolumeConfig, userPath: string): Promise<string> {
  const candidate = await resolvePath(config, userPath);
  const real = await fs.realpath(candidate);
  const root = resolve(resolveRoot(config));
  if (real !== root && !real.startsWith(root + sep)) {
    throw new VolumeAccessError(`Symlink escape detected: ${userPath}`);
  }
  return real;
}

export function createLocalAdapter(config: VolumeConfig): VolumeAdapter {
  return {
    async list(path: string): Promise<FileInfo[]> {
      const dirPath = await resolveExistingPath(config, path || ".");
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const result: FileInfo[] = [];
      for (const entry of entries) {
        const entryPath = join(path || "", entry.name).replace(/\\/g, "/");
        result.push({
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
        });
      }
      return result;
    },

    async read(path: string): Promise<Buffer> {
      const fullPath = await resolveExistingPath(config, path);
      return fs.readFile(fullPath);
    },

    async write(path: string, content: Buffer): Promise<void> {
      const candidate = await resolvePath(config, path);
      const root = resolve(resolveRoot(config));

      // Walk parent components with lstat to reject symlinks.
      let current = candidate;
      while (current !== root) {
        try {
          const stat = await fs.lstat(current);
          if (stat.isSymbolicLink()) {
            throw new VolumeAccessError(`Symlink not allowed in write path: ${path}`);
          }
        } catch (err: any) {
          if (err instanceof VolumeAccessError) throw err;
          // Path does not exist yet, which is fine.
        }
        current = resolve(current, "..");
      }

      const parent = candidate.split("/").slice(0, -1).join("/");
      if (parent) {
        await fs.mkdir(parent, { recursive: true });
      }
      await fs.writeFile(candidate, content);
    },

    async stat(path: string): Promise<FileInfo> {
      const fullPath = await resolveExistingPath(config, path);
      const stats = await fs.stat(fullPath);
      return {
        name: path.split("/").pop() || path,
        path,
        size: stats.size,
        lastModified: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    },
  };
}
