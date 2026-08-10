import { describe, expect, it } from "vitest";
import type { VolumeAdapter } from "../../../mcp/volumes/adapter.js";

export function volumeAdapterContract(implementation: string, create: () => VolumeAdapter): void {
  describe(`${implementation} volume adapter contract`, () => {
    it("supports bounded list, read, write, stat, pagination, and close behavior", async () => {
      const adapter = create();
      const first = await adapter.list("", { limit: 1 });
      expect(first.files).toHaveLength(1);
      expect(first.nextCursor).toBeDefined();
      const second = await adapter.list("", { limit: 1, cursor: first.nextCursor });
      expect(second.files).toHaveLength(1);
      expect(second.nextCursor).toBeUndefined();

      await adapter.write("new.txt", Buffer.from("ok"));
      await expect(adapter.read("new.txt", { maxBytes: 2 })).resolves.toEqual(Buffer.from("ok"));
      await expect(adapter.read("large.txt", { maxBytes: 2 })).rejects.toThrow(
        "exceeds read limit",
      );
      await expect(adapter.stat("new.txt")).resolves.toMatchObject({
        name: "new.txt",
        path: "new.txt",
        size: 2,
        isDirectory: false,
      });
      await expect(adapter.close?.()).resolves.toBeUndefined();
    });
  });
}
