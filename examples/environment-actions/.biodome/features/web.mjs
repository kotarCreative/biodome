export default function web(ctx) {
  ctx.addLanguage("node", { version: "22" });
  ctx.addProcess({
    name: "web",
    command: ["node", "server.mjs"],
    port: 3137,
    healthCheck: { type: "http", url: "http://localhost:3137/health" },
  });
}
