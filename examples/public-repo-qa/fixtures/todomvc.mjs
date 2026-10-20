export default function environment(ctx) {
  ctx.addLanguage("node", { version: "22" });
  ctx.addTool("chromium");
  ctx.addPackage("npm", "playwright", { version: "1.56.1" });
  ctx.addEnv("CYPRESS_INSTALL_BINARY", { value: "0", scope: "both" });
  ctx.addHook({
    name: "example-dependencies",
    startOn: "start.pre",
    command: ["npm", "ci", "--ignore-scripts", "--prefix", "examples/javascript-es5"],
    intent: "Install the selected TodoMVC example's locked dependencies",
  });
  ctx.addProcess({
    name: "web",
    command: ["node", "tests/server.js"],
    healthCheck: {
      type: "http",
      url: "http://localhost:8000/examples/javascript-es5/",
      startPeriod: "120s",
    },
  });
}
