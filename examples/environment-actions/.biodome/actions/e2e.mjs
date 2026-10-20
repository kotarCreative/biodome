export default function e2e(ctx) {
  ctx.addAction({
    command: ["node", "scripts/e2e.mjs"],
    intent: "Verify the candidate branch serves the expected response",
    input: { path: "/", expected: "Environment ready" },
    outputs: ["results/e2e.json"],
    timeout: "2m",
    cleanup: "never",
  });
}
