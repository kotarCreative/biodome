import { beforeEach, describe, expect, it, vi } from "vitest";

const getFiles = vi.fn();
const file = vi.fn();
vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    bucket() {
      return { getFiles, file };
    }
  },
}));

import { createGcsAdapter } from "../../../mcp/volumes/gcs.js";

const config = { name: "test", type: "gcs", target: "/test", bucket: "bucket" };
const listed = (name: string) => ({
  name,
  metadata: { size: "1", updated: "2026-01-01T00:00:00Z" },
});

describe("GCS volume adapter", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requests first and second pages without auto-pagination", async () => {
    getFiles
      .mockResolvedValueOnce([[listed("one.txt")], { pageToken: "second" }])
      .mockResolvedValueOnce([[listed("two.txt")], {}]);
    const adapter = createGcsAdapter(config);
    const first = await adapter.list("", { limit: 10 });
    const second = await adapter.list("", { limit: 10, cursor: first.nextCursor });
    expect(first.files.map((entry) => entry.path)).toEqual(["one.txt"]);
    expect(second.files.map((entry) => entry.path)).toEqual(["two.txt"]);
    expect(getFiles).toHaveBeenNthCalledWith(1, {
      prefix: "",
      delimiter: "/",
      autoPaginate: false,
      maxResults: 10,
      pageToken: undefined,
    });
    expect(getFiles).toHaveBeenNthCalledWith(2, {
      prefix: "",
      delimiter: "/",
      autoPaginate: false,
      maxResults: 10,
      pageToken: "second",
    });
  });

  it("uses metadata before creating a read stream", async () => {
    const createReadStream = vi.fn();
    file.mockReturnValue({
      getMetadata: vi.fn().mockResolvedValue([{ size: "11" }]),
      createReadStream,
    });
    await expect(createGcsAdapter(config).read("large.txt", { maxBytes: 10 })).rejects.toThrow(
      "exceeds read limit",
    );
    expect(createReadStream).not.toHaveBeenCalled();
  });
});
