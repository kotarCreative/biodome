import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = send;
    },
    ListObjectsV2Command: Command,
    GetObjectCommand: Command,
    PutObjectCommand: Command,
    HeadObjectCommand: Command,
  };
});

import { createS3Adapter } from "../../../mcp/volumes/s3.js";

const config = { name: "test", type: "s3", target: "/test", bucket: "bucket" };

describe("S3 volume adapter", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requests first and second pages with bounded provider options", async () => {
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: "one.txt", Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: "second",
      })
      .mockResolvedValueOnce({ Contents: [{ Key: "two.txt", Size: 2 }], IsTruncated: false });
    const adapter = createS3Adapter(config);
    const first = await adapter.list("", { limit: 10 });
    const second = await adapter.list("", { limit: 10, cursor: first.nextCursor });
    expect(first.files.map((file) => file.path)).toEqual(["one.txt"]);
    expect(second.files.map((file) => file.path)).toEqual(["two.txt"]);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { Bucket: "bucket", Prefix: "", Delimiter: "/", MaxKeys: 10, ContinuationToken: undefined },
      { Bucket: "bucket", Prefix: "", Delimiter: "/", MaxKeys: 10, ContinuationToken: "second" },
    ]);
  });

  it("rejects malformed cursors and known oversized objects before downloading", async () => {
    const adapter = createS3Adapter(config);
    await expect(adapter.list("", { limit: 1, cursor: "not-a-cursor" })).rejects.toThrow(
      "Invalid list cursor",
    );
    send.mockResolvedValueOnce({ ContentLength: 11 });
    await expect(adapter.read("large.txt", { maxBytes: 10 })).rejects.toThrow("exceeds read limit");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("aborts an unknown-size stream that exceeds the cap", async () => {
    const body = Object.assign(
      (async function* () {
        yield Buffer.from("too large");
      })(),
      { destroy: vi.fn() },
    );
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Body: body });
    await expect(createS3Adapter(config).read("unknown.txt", { maxBytes: 3 })).rejects.toThrow(
      "exceeds read limit",
    );
    expect(body.destroy).toHaveBeenCalledOnce();
  });
});
