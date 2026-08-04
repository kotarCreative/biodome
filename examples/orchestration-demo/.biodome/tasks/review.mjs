export default function review(ctx) {
  ctx.addTask({
    harness: "reviewer",
    prompt: "Review this example and write a short report to review.md.",
    artifacts: ["review.md"],
    timeout: "20m",
    cleanup: "always",
    requiredServices: ["redis"],
    capabilities: [
      {
        capability: "network.policy",
        level: "preferred",
        reason: "restrict agent egress when the provider supports it",
      },
    ],
    resources: { cpu: 2, memoryMiB: 4096 },
    network: {
      mode: "egress",
      allow: ["api.openai.com:443", "registry.npmjs.org:443"],
    },
    workspace: { strategy: "clone" },
    validationCommands: [["npm", "run", "validate"]],
  });
}
