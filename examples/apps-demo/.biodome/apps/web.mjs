export const dependsOn = ["api"];

export default function web(app) {
  app.requireAppEndpoint({ _tag: "AppEndpointReference", app: "api", endpoint: "http" });
  app.addProcess("web", { command: ["node", "web.mjs"], port: 3200 });
  app.exposeEndpoint("http", { process: "web" });
}
