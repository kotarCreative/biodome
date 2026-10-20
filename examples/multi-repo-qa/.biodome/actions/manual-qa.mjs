export default function manualQa(ctx) {
  ctx.addAction({
    command: ["sh", "-c", "mkdir -p qa && agent-browser open http://localhost:4200 && agent-browser screenshot qa/desktop.png && agent-browser close"],
    intent: "Capture the frontend for an external agent to inspect.",
    outputs: ["qa/desktop.png"],
    requiredProcesses: ["frontend", "backend"],
    timeout: "5m",
    cleanup: "never",
  });
}
