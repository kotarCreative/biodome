export default function localApi(ctx) {
  ctx.addProcess({
    name: "local-api", command: ["node", "api.mjs"],
    environment: { API_PORT: "8080", API_MODE: "normal" },
    healthCheck: { type: "http", url: "http://127.0.0.1:8080/health" },
  });
}
