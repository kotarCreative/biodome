import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const { iterations } = JSON.parse(process.env.BIODOME_ACTION_INPUT ?? "{}");
const [output] = JSON.parse(process.env.BIODOME_ACTION_OUTPUTS ?? "[]");
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000 || !output) {
  throw new Error("iterations must be 1–1000 and an output must be declared");
}
const samples = [];
for (let i = 0; i < iterations; i++) {
  const start = performance.now();
  const response = await fetch("http://localhost:3137/health", { signal: AbortSignal.timeout(10000) });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`Unexpected HTTP status: ${response.status}`);
  samples.push(performance.now() - start);
}
const sorted = [...samples].sort((a, b) => a - b);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ intent: process.env.BIODOME_ACTION_INTENT, iterations, unit: "ms", median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], samples }, null, 2));
console.log(`Measured ${iterations} requests`);
