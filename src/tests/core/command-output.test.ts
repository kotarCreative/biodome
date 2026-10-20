import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CommandOutput } from "../../core/command-output.js";
import { runProcess } from "../../runtime/proc.js";

describe("machine-readable action output", () => {
  it("redirects provider stdout to stderr before presenting the final JSON", async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    try {
      await Effect.runPromise(
        runProcess({
          command: process.execPath,
          args: ["-e", "process.stdout.write('provider progress')"],
        }).pipe(Effect.provideService(CommandOutput, { progressToStderr: true })),
      );
      expect(chunks.join("")).toBe("provider progress");
    } finally {
      write.mockRestore();
    }
  });
});
