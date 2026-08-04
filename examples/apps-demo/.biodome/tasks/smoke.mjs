export default function smoke(ctx) {
  ctx.addTask({
    harness: "tester",
    prompt: "Smoke test the demo.",
    artifacts: [],
    timeout: "5m",
    cleanup: "always",
  });
}
