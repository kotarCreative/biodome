import { beforeEach, describe, expect, it, vi } from "vitest";

const byPage = vi.fn();
const listBlobsByHierarchy = vi.fn(() => ({ byPage }));
const getBlobClient = vi.fn();
vi.mock("@azure/storage-blob", () => ({
  StorageSharedKeyCredential: class {},
  BlobServiceClient: class {
    getContainerClient() {
      return { listBlobsByHierarchy, getBlobClient, getBlockBlobClient: vi.fn() };
    }
  },
}));

import { createAzureAdapter } from "../../../mcp/volumes/azure.js";

const config = {
  name: "test",
  type: "azure",
  target: "/test",
  account: "account",
  container: "container",
  credentials: { accountKey: "key" },
};

describe("Azure volume adapter", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requests first and second hierarchy pages", async () => {
    byPage
      .mockReturnValueOnce({
        next: vi.fn().mockResolvedValue({
          value: {
            segment: { blobItems: [{ name: "one.txt", properties: {} }] },
            continuationToken: "second",
          },
        }),
      })
      .mockReturnValueOnce({
        next: vi.fn().mockResolvedValue({
          value: { segment: { blobItems: [{ name: "two.txt", properties: {} }] } },
        }),
      });
    const adapter = createAzureAdapter(config);
    const first = await adapter.list("", { limit: 10 });
    const second = await adapter.list("", { limit: 10, cursor: first.nextCursor });
    expect(first.files.map((entry) => entry.path)).toEqual(["one.txt"]);
    expect(second.files.map((entry) => entry.path)).toEqual(["two.txt"]);
    expect(byPage).toHaveBeenNthCalledWith(1, { continuationToken: undefined, maxPageSize: 10 });
    expect(byPage).toHaveBeenNthCalledWith(2, { continuationToken: "second", maxPageSize: 10 });
  });

  it("checks blob properties before downloading", async () => {
    const download = vi.fn();
    getBlobClient.mockReturnValue({
      getProperties: vi.fn().mockResolvedValue({ contentLength: 11 }),
      download,
    });
    await expect(createAzureAdapter(config).read("large.txt", { maxBytes: 10 })).rejects.toThrow(
      "exceeds read limit",
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects configurations without account or container via typed errors", () => {
    const { account: _account, ...withoutAccount } = config;
    expect(() => createAzureAdapter(withoutAccount)).toThrow("requires an account");
    const { container: _container, ...withoutContainer } = config;
    expect(() => createAzureAdapter(withoutContainer)).toThrow("requires a container");
  });
});
