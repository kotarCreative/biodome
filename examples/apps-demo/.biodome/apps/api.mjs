export default function api(app) {
  app.addRepository({ url: "https://example.test/api.git" });
  app.requireService("postgres");
  app.addProcess("web", { command: ["node", "server.mjs"], port: 3100 });
  app.exposeEndpoint("http", { process: "web" });
}
