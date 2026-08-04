export default function agent(ctx) {
  ctx.addLanguage("node", { version: "22", packageManager: "npm" });
  ctx.addCodexHarness({ name: "reviewer", apiKey: { env: "OPENAI_API_KEY" } });
}
