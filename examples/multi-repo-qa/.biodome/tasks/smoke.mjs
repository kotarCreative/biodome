export default function smoke(ctx) {
  ctx.addTask({
    harness: "tester",
    prompt: "Verify both repos are cloned and both processes respond. Write smoke.md.",
    artifacts: ["smoke.md"],
    timeout: "10m",
    cleanup: "always",
    requiredProcesses: ["frontend", "backend"],
    validationCommands: [["npm", "run", "validate"]],
  });
}
