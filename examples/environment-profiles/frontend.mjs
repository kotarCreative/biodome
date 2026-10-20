import { createServer } from "node:http";

createServer(async (request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  try {
    const upstream = await fetch(process.env.API_URL, { signal: AbortSignal.timeout(2000) });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        state: upstream.ok ? "ready" : "unavailable",
        upstreamStatus: upstream.status,
      }),
    );
  } catch {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state: "unavailable" }));
  }
}).listen(3137, "0.0.0.0");
