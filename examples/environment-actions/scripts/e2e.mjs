import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const input = JSON.parse(process.env.BIODOME_ACTION_INPUT ?? "{}");
const [output] = JSON.parse(process.env.BIODOME_ACTION_OUTPUTS ?? "[]");
if (typeof input.path !== "string" || !input.path.startsWith("/") || typeof input.expected !== "string" || !output) {
  throw new Error("Expected path, expected response text, and one output file");
}
const url = new URL("http://localhost:3137");
url.pathname = input.path;
const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
const body = await response.text();
const passed = response.ok && body.includes(input.expected);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ intent: process.env.BIODOME_ACTION_INTENT, input, status: passed ? "passed" : "failed", httpStatus: response.status }, null, 2));
console.log(passed ? "E2E checks passed" : "E2E checks failed");
process.exitCode = passed ? 0 : 1;
