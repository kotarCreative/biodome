export default function errorApi(ctx) {
  ctx.addProcess({
    name: "error-api", command: ["node", "api.mjs"],
    environment: { API_PORT: "8081", API_MODE: "unavailable" },
    healthCheck: { type: "http", url: "http://127.0.0.1:8081/health" },
  });
}
