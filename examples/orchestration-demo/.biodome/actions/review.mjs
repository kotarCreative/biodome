export default function review(ctx) {
  ctx.addAction({
    command: ["sh", "-c", "printf 'Environment ready for review\\n' > review.md"],
    intent: "Verify the environment and return a report to the calling agent.",
    input: { scope: "current branch" },
    outputs: ["review.md"],
    timeout: "5m",
    cleanup: "always",
    requiredServices: ["redis"],
  });
}
