import { createServer } from "node:http";

createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/health") {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ message: "Environment ready" }));
}).listen(3137, "0.0.0.0");
