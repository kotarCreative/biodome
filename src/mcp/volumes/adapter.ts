export interface FileInfo {
  name: string;
  path: string;
  size?: number;
  lastModified?: Date;
  isDirectory: boolean;
}

export interface ListOptions {
  readonly limit: number;
  readonly cursor?: string;
}

export interface FilePage {
  readonly files: readonly FileInfo[];
  readonly nextCursor?: string;
}

export interface ReadOptions {
  readonly maxBytes: number;
}

export interface VolumeCredentials {
  [key: string]: string | { env: string } | undefined;
}

export interface VolumeConfig {
  name: string;
  type: string;
  target: string;
  source?: string;
  bucket?: string;
  prefix?: string;
  path?: string;
  endpoint?: string;
  account?: string;
  container?: string;
  host?: string;
  port?: number;
  share?: string;
  url?: string;
  vendor?: string;
  credentials?: VolumeCredentials;
  proxy?: boolean;
  readOnly?: boolean;
  allowedPaths?: string[];
}

export interface VolumeAdapter {
  list(path: string, options: ListOptions): Promise<FilePage>;
  read(path: string, options: ReadOptions): Promise<Buffer>;
  write(path: string, content: Buffer): Promise<void>;
  stat(path: string): Promise<FileInfo>;
  close?(): Promise<void>;
}

const cursorPrefix = "biodome:v1:";

export function encodeCursor(token: string): string {
  return cursorPrefix + Buffer.from(token, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor.startsWith(cursorPrefix)) throw new VolumeAccessError("Invalid list cursor");
  const encoded = cursor.slice(cursorPrefix.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new VolumeAccessError("Invalid list cursor");
  const token = Buffer.from(encoded, "base64url").toString("utf8");
  if (!token || encodeCursor(token) !== cursor) throw new VolumeAccessError("Invalid list cursor");
  return token;
}

export async function readBounded(
  body: AsyncIterable<unknown> | undefined,
  maxBytes: number,
  path: string,
): Promise<Buffer> {
  if (!body) throw new VolumeAccessError(`Empty body for ${path}`);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > maxBytes) {
        (body as { destroy?: (error?: Error) => void }).destroy?.();
        throw new VolumeAccessError(`File size exceeds read limit of ${maxBytes} bytes`);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof VolumeAccessError) throw error;
    throw error;
  }
  return Buffer.concat(chunks, total);
}

export function rejectOversized(size: number | undefined, maxBytes: number, path: string): void {
  if (size !== undefined && size > maxBytes)
    throw new VolumeAccessError(
      `File ${path} size (${size} bytes) exceeds read limit of ${maxBytes} bytes`,
    );
}

export function resolveCredential(value: string | { env: string } | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return process.env[value.env];
}

export function resolveCredentials(
  credentials?: VolumeCredentials,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  if (!credentials) return result;
  for (const [key, value] of Object.entries(credentials)) {
    result[key] = resolveCredential(value);
  }
  return result;
}

export function matchesAllowedPath(path: string, allowedPaths?: string[]): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return false;
  return allowedPaths.some((pattern) => matchGlob(path, pattern));
}

function matchGlob(value: string, pattern: string): boolean {
  const normalized = value.replace(/^\/+/, "");
  const parts = pattern.split("/");
  const valueParts = normalized.split("/");

  let vi = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    if (part === "**") {
      // ** matches any number of path segments.
      const remainingPattern = parts.slice(pi + 1).join("/");
      if (remainingPattern === "") return true;
      for (let j = vi; j < valueParts.length; j++) {
        if (matchGlob(valueParts.slice(j).join("/"), remainingPattern)) return true;
      }
      return false;
    }
    if (vi >= valueParts.length) return false;
    if (!matchSegment(valueParts[vi], part)) return false;
    vi++;
  }
  return vi === valueParts.length;
}

function matchSegment(value: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$",
  );
  return regex.test(value);
}

export class VolumeAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VolumeAccessError";
  }
}
