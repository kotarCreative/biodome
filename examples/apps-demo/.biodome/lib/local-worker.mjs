export function addLocalWorker(app) {
  app.addProcess("worker", { command: ["node", "worker.mjs"] });
}
