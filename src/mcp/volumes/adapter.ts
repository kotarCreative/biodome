export interface FileInfo {
  name: string
  path: string
  size?: number
  lastModified?: Date
  isDirectory: boolean
}

export interface VolumeCredentials {
  [key: string]: string | { env: string } | undefined
}

export interface VolumeConfig {
  name: string
  type: string
  target: string
  bucket?: string
  prefix?: string
  path?: string
  endpoint?: string
  account?: string
  container?: string
  host?: string
  port?: number
  share?: string
  url?: string
  vendor?: string
  credentials?: VolumeCredentials
  proxy?: boolean
  readOnly?: boolean
  allowedPaths?: string[]
}

export interface VolumeAdapter {
  list(path: string): Promise<FileInfo[]>
  read(path: string): Promise<Buffer>
  write(path: string, content: Buffer): Promise<void>
  stat(path: string): Promise<FileInfo>
}

export function resolveCredential(value: string | { env: string } | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  return process.env[value.env]
}

export function resolveCredentials(credentials?: VolumeCredentials): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  if (!credentials) return result
  for (const [key, value] of Object.entries(credentials)) {
    result[key] = resolveCredential(value)
  }
  return result
}

export function matchesAllowedPath(path: string, allowedPaths?: string[]): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return true
  return allowedPaths.some((pattern) => matchGlob(path, pattern))
}

function matchGlob(value: string, pattern: string): boolean {
  const normalized = value.replace(/^\/+/, "")
  const parts = pattern.split("/")
  const valueParts = normalized.split("/")

  let vi = 0
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi]
    if (part === "**") {
      // ** matches any number of path segments.
      const remainingPattern = parts.slice(pi + 1).join("/")
      if (remainingPattern === "") return true
      for (let j = vi; j < valueParts.length; j++) {
        if (matchGlob(valueParts.slice(j).join("/"), remainingPattern)) return true
      }
      return false
    }
    if (vi >= valueParts.length) return false
    if (!matchSegment(valueParts[vi], part)) return false
    vi++
  }
  return vi === valueParts.length
}

function matchSegment(value: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$"
  )
  return regex.test(value)
}

export class VolumeAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VolumeAccessError"
  }
}
