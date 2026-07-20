import { promises as fs } from "node:fs"
import { join } from "node:path"
import { VolumeAdapter, FileInfo, VolumeConfig, VolumeAccessError } from "./adapter.js"

const PROJECT_ROOT = "/workspace"

function resolveRoot(config: VolumeConfig): string {
  if (!config.source) {
    throw new VolumeAccessError(`Local proxy volume ${config.name} requires a source path`)
  }
  if (config.source.startsWith("/")) {
    // Absolute host paths are only accessible if they happen to be mounted.
    return config.source
  }
  return join(PROJECT_ROOT, config.source)
}

function resolvePath(config: VolumeConfig, path: string): string {
  const root = resolveRoot(config)
  const normalized = path.replace(/^\/+/, "")
  const fullPath = join(root, normalized)
  // Prevent traversal outside the volume root.
  const relative = fullPath.replace(root, "")
  if (relative.includes("..")) {
    throw new VolumeAccessError(`Path traversal not allowed: ${path}`)
  }
  return fullPath
}

export function createLocalAdapter(config: VolumeConfig): VolumeAdapter {
  return {
    async list(path: string): Promise<FileInfo[]> {
      const dirPath = resolvePath(config, path || ".")
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const result: FileInfo[] = []
      for (const entry of entries) {
        const entryPath = join(path || "", entry.name).replace(/\\/g, "/")
        result.push({
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
        })
      }
      return result
    },

    async read(path: string): Promise<Buffer> {
      const fullPath = resolvePath(config, path)
      return fs.readFile(fullPath)
    },

    async write(path: string, content: Buffer): Promise<void> {
      const fullPath = resolvePath(config, path)
      const parent = fullPath.split("/").slice(0, -1).join("/")
      if (parent) {
        await fs.mkdir(parent, { recursive: true })
      }
      await fs.writeFile(fullPath, content)
    },

    async stat(path: string): Promise<FileInfo> {
      const fullPath = resolvePath(config, path)
      const stats = await fs.stat(fullPath)
      return {
        name: path.split("/").pop() || path,
        path,
        size: stats.size,
        lastModified: stats.mtime,
        isDirectory: stats.isDirectory(),
      }
    },
  }
}
