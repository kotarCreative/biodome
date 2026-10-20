export default function frontend(ctx) {
  ctx.addLanguage("node", { version: "22" });
  ctx.addEnv("API_URL", { value: "http://127.0.0.1:8080" });
  ctx.addEnv("QA_EXPECT_STATE", { value: "ready" });
  ctx.addProcess({
    name: "frontend", command: ["node", "frontend.mjs"],
    healthCheck: { type: "http", url: "http://127.0.0.1:3137/health" },
  });
}
