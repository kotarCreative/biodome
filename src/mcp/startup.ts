import fs from "node:fs/promises";
import http from "node:http";
import { buildUpstreams, createDefaultDependencies, createMcpApplication } from "./application.js";
import { decodeMcpPlan } from "./plan.js";

export function parseArgs(args: readonly string[]): { port: number; planPath: string } {
  let port = 3001;
  let planPath = "/workspace/.biodome-build/plan.json";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--port" && args[index + 1] !== undefined)
      port = Number.parseInt(args[++index], 10);
    if (args[index] === "--plan" && args[index + 1] !== undefined) planPath = args[++index];
  }
  return { port, planPath };
}
export interface HttpListener {
  listen(port: number, host: string): unknown;
}
export function listenOnLoopback(server: HttpListener, port: number): void {
  server.listen(port, "127.0.0.1");
}
export async function startMcpServer(
  args: readonly string[] = process.argv.slice(2),
): Promise<http.Server> {
  const { port, planPath } = parseArgs(args);
  const plan = decodeMcpPlan(JSON.parse(await fs.readFile(planPath, "utf8")) as unknown);
  const application = await createMcpApplication(
    plan,
    createDefaultDependencies(buildUpstreams(plan, process.env).providers, {
      connectTimeoutMs: plan.mcp.providerConnectTimeoutMs,
      requestTimeoutMs: plan.mcp.providerRequestTimeoutMs,
      catalogConcurrency: plan.mcp.providerCatalogConcurrency,
    }),
  );
  const server = http.createServer(application.handler);
  listenOnLoopback(server, port);
  const shutdown = () => {
    const timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    server.close(() => {
      void application.close().finally(() => {
        clearTimeout(timer);
        process.exit(0);
      });
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}
