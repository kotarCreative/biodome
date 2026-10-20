export default function environment(ctx) {
  ctx.addLanguage("node", { version: "22" });
  ctx.addProcess({
    name: "web",
    command: ["node", "examples/hello-world/index.js"],
    healthCheck: { type: "http", url: "http://localhost:3000/" },
  });
}
