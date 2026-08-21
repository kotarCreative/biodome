import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { resolve, join, sep } from "node:path";
import {
  VolumeAdapter,
  FileInfo,
  VolumeConfig,
  VolumeAccessError,
  decodeCursor,
  encodeCursor,
  rejectOversized,
} from "./adapter.js";

const PROJECT_ROOT = "/workspace";

// Hard ceiling on directory entries materialized per listing. This is generous
// headroom above the configurable maxListEntries page size (default 100), so
// normal directories paginate unchanged while pathological ones fail fast
// instead of spiking memory, mirroring how readBounded caps read streams.
export const MAX_DIRECTORY_SCAN_ENTRIES = 10_000;

async function listDirectoryEntriesBounded(
  dirPath: string,
  displayPath: string,
  maxEntries: number,
): Promise<Dirent[]> {
  const directory = await fs.opendir(dirPath);
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) return entries;
      entries.push(entry);
      if (entries.length > maxEntries) {
        throw new VolumeAccessError(
          `Directory ${displayPath} exceeds the maximum of ${maxEntries} entries per listing`,
        );
      }
    }
  } finally {
    await directory.close().catch(() => {});
  }
}

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
  const root = resolve(resolveRoot(config));
  // Compare realpaths on both sides so a root reached through host-level
  // symlinks (e.g. macOS /var -> /private/var) is not mistaken for an escape.
  const [real, realRoot] = await Promise.all([
    fs.realpath(candidate),
    fs.realpath(root).catch(() => root),
  ]);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new VolumeAccessError(`Symlink escape detected: ${userPath}`);
  }
  return real;
}

export function createLocalAdapter(config: VolumeConfig): VolumeAdapter {
  return {
    async list(path, options) {
      const userPath = path || ".";
      const dirPath = await resolveExistingPath(config, userPath);
      const scope = { kind: "local", volumeName: config.name, path: userPath };
      const cursor = decodeCursor(options.cursor, scope);
      const entries = await listDirectoryEntriesBounded(
        dirPath,
        userPath,
        MAX_DIRECTORY_SCAN_ENTRIES,
      );
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > entries.length) {
        throw new VolumeAccessError("Invalid list cursor");
      }
      const files: FileInfo[] = [];
      const page = entries.slice(offset, offset + options.limit);
      for (const entry of page) {
        const entryPath = join(path || "", entry.name).replace(/\\/g, "/");
        files.push({
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
        });
      }
      const next = offset + page.length;
      return {
        files,
        nextCursor: next < entries.length ? encodeCursor(String(next), scope) : undefined,
      };
    },

    async read(path, options) {
      const fullPath = await resolveExistingPath(config, path);
      rejectOversized((await fs.stat(fullPath)).size, options.maxBytes, path);
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
