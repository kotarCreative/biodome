import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [output] = JSON.parse(process.env.BIODOME_ACTION_OUTPUTS);
const input = JSON.parse(process.env.BIODOME_ACTION_INPUT);
console.log(
  "BIODOME_EVENT " +
    JSON.stringify({
      type: "progress",
      message: "Checking the same frontend route against the selected API setup",
    }),
);
const response = await fetch("http://127.0.0.1:3137", { signal: AbortSignal.timeout(5000) });
const body = await response.json();
const expectedState = input.expectedState ?? process.env.QA_EXPECT_STATE;
const expectedStatus = expectedState === "ready" ? 200 : 503;
const passed =
  response.ok && body.state === expectedState && body.upstreamStatus === expectedStatus;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ passed, expectedState, observed: body }, null, 2));
console.log(
  "BIODOME_EVENT " +
    JSON.stringify({
      type: "check",
      name: "API response handling",
      status: passed ? "passed" : "failed",
      message: `Expected ${expectedState}; observed ${body.state}`,
    }),
);
process.exitCode = passed ? 0 : 7;
