import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDotenv, readDotenv, mergeDotenv, writeDotenv } from "../../core/dotenv.js";

describe("parseDotenv", () => {
  it("parses basic KEY=value pairs", () => {
    const file = parseDotenv("FOO=bar\nBAZ=qux\n");
    expect(file.entries).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("ignores comments and blank lines", () => {
    const file = parseDotenv("# comment\n\nFOO=bar\n  # indented comment\n");
    expect(file.entries).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("unquotes double-quoted values with escapes", () => {
    const file = parseDotenv('GREETING="hello\\nworld"\n');
    expect(file.entries).toEqual([{ key: "GREETING", value: "hello\nworld" }]);
  });

  it("unquotes single-quoted values literally", () => {
    const file = parseDotenv("LITERAL='hello\\nworld'\n");
    expect(file.entries).toEqual([{ key: "LITERAL", value: "hello\\nworld" }]);
  });

  it("preserves unquoted values as-is", () => {
    const file = parseDotenv("RAW=https://example.com?x=1\n");
    expect(file.entries).toEqual([{ key: "RAW", value: "https://example.com?x=1" }]);
  });
});

describe("readDotenv", () => {
  it("returns empty entries when the file does not exist", () => {
    const file = readDotenv(join(tmpdir(), `missing-${Date.now()}.env`));
    expect(file.entries).toEqual([]);
  });
});

describe("mergeDotenv", () => {
  it("adds new keys and updates existing keys", () => {
    const file = parseDotenv("FOO=old\nBAR=keep\n");
    const merged = mergeDotenv(file, { FOO: "new", BAZ: "added" });
    expect(Object.fromEntries(merged.entries.map((e) => [e.key, e.value]))).toEqual({
      FOO: "new",
      BAR: "keep",
      BAZ: "added",
    });
  });

  it("removes keys set to empty or undefined", () => {
    const file = parseDotenv("FOO=bar\nBAZ=qux\n");
    const merged = mergeDotenv(file, { FOO: "", BAZ: undefined });
    expect(merged.entries.map((e) => e.key)).toEqual([]);
  });
});

describe("writeDotenv", () => {
  it("round-trips values and quotes values containing spaces or special chars", () => {
    const dir = mkdtempSync(join(tmpdir(), "dotenv-"));
    const path = join(dir, ".env");
    try {
      writeDotenv(path, {
        entries: [
          { key: "PLAIN", value: "plain" },
          { key: "EMPTY", value: "" },
          { key: "SPACES", value: "hello world" },
          { key: "HASH", value: "a#b" },
          { key: "QUOTE", value: 'say "hi"' },
          { key: "NEWLINE", value: "a\nb" },
          { key: "BACKSLASH", value: "C:\\temp\\new" },
          { key: "LITERAL_ESCAPE", value: "literal\\ntext" },
          { key: "SHELL", value: "$(touch /tmp/should-not-run) $HOME `whoami`" },
        ],
      });
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("PLAIN=plain");
      expect(content).toContain('EMPTY=""');
      expect(content).toContain('SPACES="hello world"');
      expect(content).toContain('HASH="a#b"');
      expect(content).toContain('QUOTE="say \\"hi\\""');
      expect(content).toContain('NEWLINE="a\\nb"');
      expect(content).toContain('BACKSLASH="C:\\\\temp\\\\new"');
      expect(content).toContain('LITERAL_ESCAPE="literal\\\\ntext"');
      expect(content).toContain('SHELL="\\$(touch /tmp/should-not-run) \\$HOME \\`whoami\\`"');
      expect(readDotenv(path).entries).toEqual([
        { key: "PLAIN", value: "plain" },
        { key: "EMPTY", value: "" },
        { key: "SPACES", value: "hello world" },
        { key: "HASH", value: "a#b" },
        { key: "QUOTE", value: 'say "hi"' },
        { key: "NEWLINE", value: "a\nb" },
        { key: "BACKSLASH", value: "C:\\temp\\new" },
        { key: "LITERAL_ESCAPE", value: "literal\\ntext" },
        { key: "SHELL", value: "$(touch /tmp/should-not-run) $HOME `whoami`" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
