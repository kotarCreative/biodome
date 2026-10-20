import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const input = JSON.parse(process.env.BIODOME_ACTION_INPUT || "{}");
const [output] = JSON.parse(process.env.BIODOME_ACTION_OUTPUTS);
const checks = [];
let status = "running";
const emit = (report) => console.log("BIODOME_EVENT " + JSON.stringify(report));
const save = async () => {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ status, intent: process.env.BIODOME_ACTION_INTENT, checks }, null, 2),
  );
};
async function check(name, passed) {
  checks.push({ name, status: passed ? "passed" : "failed" });
  emit({ type: "check", name, status: passed ? "passed" : "failed", message: name });
  await save();
  if (!passed) throw new Error(name);
}
try {
  await save();
  emit({ type: "progress", message: "Checking the pinned Express hello-world application" });
  const response = await fetch("http://localhost:3000/");
  const body = await response.text();
  await check("GET returns Hello World", response.status === 200 && body === "Hello World");
  await check(
    "Response declares HTML",
    response.headers.get("content-type")?.startsWith("text/html"),
  );
  const head = await fetch("http://localhost:3000/", { method: "HEAD" });
  await check("HEAD has no response body", head.status === 200 && (await head.text()) === "");
  const missing = await fetch("http://localhost:3000/does-not-exist");
  await check("Unknown route is 404", missing.status === 404);
  // Undici's default no-cache request header intentionally bypasses freshness.
  const cached = await fetch("http://localhost:3000/", {
    cache: "no-store",
    headers: { "If-None-Match": response.headers.get("etag"), "Cache-Control": "max-age=0" },
  });
  await check("ETag conditional request is 304", cached.status === 304);
  emit({ type: "progress", message: "Waiting to exercise quiet-operation heartbeats" });
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(Number(input.pauseSeconds ?? 6), 30) * 1000),
  );
  if (input.forceFailure)
    await check("Intentional negative control (not an upstream defect)", false);
  status = "passed";
} catch (error) {
  status = "failed";
  emit({ type: "progress", message: String(error) });
  process.exitCode = 7;
} finally {
  await save();
  emit({ type: "artifact", message: "HTTP QA evidence written", path: output });
}
