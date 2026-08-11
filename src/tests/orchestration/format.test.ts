import { describe, expect, it } from "vitest";
import { formatCompatibilityReport } from "../../orchestration/format.js";

describe("formatCompatibilityReport", () => {
  it("formats an incompatible provider with actionable required and preferred issues", () => {
    const output = formatCompatibilityReport({
      provider: "aws-ecs",
      compatible: false,
      missing: [
        {
          kind: "capability",
          level: "required",
          subject: "network.policy",
          reason: "allowlisted egress",
        },
      ],
      warnings: [{ kind: "capability", level: "preferred", subject: "snapshot.create" }],
      supported: ["exec.inplace", "artifact.collect"],
    });

    expect(output).toBe(
      [
        "Provider: aws-ecs",
        "Compatibility: incompatible",
        "Missing required capabilities:",
        "  - network.policy: allowlisted egress",
        "Warnings:",
        "  - snapshot.create",
        "Supported capabilities: artifact.collect, exec.inplace",
      ].join("\n"),
    );
  });

  it("keeps a compatible report concise", () => {
    expect(
      formatCompatibilityReport({
        provider: "docker-sandbox",
        compatible: true,
        missing: [],
        warnings: [],
        supported: [],
      }),
    ).toBe(
      "Provider: docker-sandbox\nCompatibility: compatible\nAll declared requirements are supported.",
    );
  });
});
