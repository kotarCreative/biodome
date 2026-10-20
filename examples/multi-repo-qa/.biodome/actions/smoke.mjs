export default function smoke(ctx) {
  ctx.addAction({
    command: ["node", "-e", "Promise.all(['http://localhost:4200', 'http://localhost:3100/health'].map(async url => { const r = await fetch(url); if (!r.ok) throw new Error(url) })).then(() => require('node:fs').writeFileSync('smoke.md', 'Both applications are healthy'))"],
    intent: "Verify both applications respond and return a report.",
    outputs: ["smoke.md"],
    timeout: "10m",
    cleanup: "always",
    requiredProcesses: ["frontend", "backend"],
    validationCommands: [["npm", "run", "validate"]],
  });
}
