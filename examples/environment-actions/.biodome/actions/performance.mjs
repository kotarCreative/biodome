export default function performance(ctx) {
  ctx.addAction({
    command: ["node", "scripts/performance.mjs"],
    intent: "Measure response latency on this branch",
    input: { iterations: 25 },
    outputs: ["results/performance.json"],
    timeout: "2m",
    cleanup: "never",
  });
}
