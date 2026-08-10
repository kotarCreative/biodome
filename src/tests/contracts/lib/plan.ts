import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { Plan } from "../../../core/plan.js";

export function canonicalPlanSchemaContract(
  implementation: string,
  schema: typeof import("../../../core/plan.js").PlanSchema,
  fixture: Plan,
): void {
  describe(`${implementation} canonical schema contract`, () => {
    it("decodes and encodes a complete plan without changing secret references", () => {
      const encoded = Schema.encodeSync(schema)(fixture);
      const decoded = Schema.decodeSync(schema)(JSON.parse(JSON.stringify(encoded)));
      expect(decoded).toEqual(fixture);
      expect(decoded.build.mcpConfig.token).toEqual({ env: "MCP_TOKEN" });
      expect(decoded.runtime.envVars.find((entry) => entry.key === "API_TOKEN")?.from).toEqual({
        env: "API_TOKEN",
      });
    });
  });
}
