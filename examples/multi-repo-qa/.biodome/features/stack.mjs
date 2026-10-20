// Multi-repo stack: two repositories are cloned side by side at container
// startup, and each declared process runs with its workingDir inside the
// repository it serves. Substitute your own clone URLs for the placeholders.
export default function stack(ctx) {
  ctx.addLanguage("node", { version: "22", packageManager: "npm" });
  ctx.addLanguage("python", { version: "3.12" });

  ctx.addRepo({
    name: "frontend",
    url: "https://github.com/acme/frontend.git",
    branch: "main",
    path: "repos/frontend",
  });

  ctx.addRepo({
    name: "backend",
    url: "https://github.com/acme/backend.git",
    branch: "main",
    path: "repos/backend",
  });

  ctx.addProcess({
    name: "frontend",
    command: ["python", "-m", "http.server", "4200"],
    port: 4200,
    workingDir: "/workspace/repos/frontend",
    healthCheck: { type: "http", url: "http://localhost:4200/" },
  });

  ctx.addProcess({
    name: "backend",
    command: ["node", "server.mjs"],
    port: 3100,
    workingDir: "/workspace/repos/backend",
    healthCheck: { type: "http", url: "http://localhost:3100/health" },
    environment: { PORT: "3100" },
  });

}
