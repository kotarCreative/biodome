import { createServer } from "node:http";

createServer((request, response) => {
  if (request.url === "/health") {
    response.end("ok");
    return;
  }
  response.writeHead(process.env.API_MODE === "unavailable" ? 503 : 200);
  response.end(process.env.API_MODE === "unavailable" ? "Unavailable" : "Ready");
}).listen(Number(process.env.API_PORT), "0.0.0.0");
