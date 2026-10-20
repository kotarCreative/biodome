export default function smoke(ctx) {
  ctx.addAction({
    command: ["node", "-e", "fetch('http://localhost:3100').then(r => { if (!r.ok) process.exit(1) })"],
    intent: "Smoke test the demo.",
    timeout: "5m",
    cleanup: "always",
  });
}
