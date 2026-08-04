import { defineAppRecipe, service } from "@kotarcreative/biodome/app";

export const basic = defineAppRecipe({
  id: "@biodome-test/app-basic",
  apiVersion: 1,
  expand(app, options) {
    app.addRepository({ url: options.repo });
    if (options.database) app.requireService(service(options.database));
    app.addProcess("web", { command: ["node", "server.mjs"], port: options.port ?? 3100 });
    app.exposeEndpoint("http", { process: "web" });
  },
});
