import { readFileSync, writeFileSync } from "node:fs";

export interface DotenvEntry {
  readonly key: string;
  readonly value: string;
}

export interface DotenvFile {
  readonly entries: DotenvEntry[];
  readonly trailingBlank?: boolean;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const quoted = value.slice(1, -1);
    let result = "";
    for (let index = 0; index < quoted.length; index++) {
      const character = quoted[index];
      if (character !== "\\" || index === quoted.length - 1) {
        result += character;
        continue;
      }

      const escaped = quoted[++index];
      switch (escaped) {
        case "n":
          result += "\n";
          break;
        case "r":
          result += "\r";
          break;
        case "t":
          result += "\t";
          break;
        case '"':
        case "\\":
        case "$":
        case "`":
          result += escaped;
          break;
        default:
          result += `\\${escaped}`;
      }
    }
    return result;
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

/**
 * Parse a dotenv-style file into key/value entries. Comments and blank lines
 * are dropped; values are unquoted.
 */
export function parseDotenv(content: string): DotenvFile {
  const entries: DotenvEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    entries.push({ key, value: unquote(rawValue) });
  }
  return { entries };
}

export function readDotenv(path: string): DotenvFile {
  try {
    return parseDotenv(readFileSync(path, "utf-8"));
  } catch {
    return { entries: [] };
  }
}

/**
 * Merge new values into an existing dotenv file, preserving any entries that
 * are not being updated. Values are quoted when necessary.
 */
export function mergeDotenv(
  file: DotenvFile,
  updates: Readonly<Record<string, string | undefined>>,
): DotenvFile {
  const entries = new Map(file.entries.map((entry) => [entry.key, entry]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === "") {
      entries.delete(key);
    } else {
      entries.set(key, { key, value });
    }
  }
  return { entries: [...entries.values()] };
}

export function writeDotenv(path: string, file: DotenvFile): void {
  const lines = file.entries.map(({ key, value }) => `${key}=${quoteIfNeeded(value)}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
}
