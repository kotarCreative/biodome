export default function environment(ctx) {
  ctx.addLanguage("python", { version: "3.12" });
  ctx.addPackage("pip", "uvicorn", { version: "0.34.3" });
  ctx.addEnv("PYTHONPATH", { value: "/workspace/.qa-deps" });
  ctx.addHook({
    name: "project-dependencies",
    startOn: "start.pre",
    command: [
      "python",
      "-m",
      "pip",
      "install",
      "--no-cache-dir",
      "--target",
      "/workspace/.qa-deps",
      ".",
    ],
    intent:
      "Install the checked-out FastAPI project's declared dependencies inside the environment",
  });
  ctx.addProcess({
    name: "web",
    command: [
      "python",
      "-m",
      "uvicorn",
      "docs_src.body.tutorial001_py310:app",
      "--host",
      "0.0.0.0",
      "--port",
      "8000",
    ],
    healthCheck: { type: "http", url: "http://localhost:8000/openapi.json", startPeriod: "120s" },
  });
}
