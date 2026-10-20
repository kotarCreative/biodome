import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "/usr/local/lib/node_modules/playwright/index.mjs";

const input = JSON.parse(process.env.BIODOME_ACTION_INPUT || "{}");
const [output, desktop, mobile] = JSON.parse(process.env.BIODOME_ACTION_OUTPUTS);
const checks = [];
const errors = [];
let status = "running";
const emit = (report) => console.log("BIODOME_EVENT " + JSON.stringify(report));
const save = async () => {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ status, intent: process.env.BIODOME_ACTION_INTENT, checks, errors }, null, 2),
  );
};
async function check(name, passed) {
  checks.push({ name, status: passed ? "passed" : "failed" });
  emit({ type: "check", name, status: passed ? "passed" : "failed", message: name });
  await save();
  if (!passed) throw new Error(name);
}
let browser;
let page;
try {
  await save();
  emit({
    type: "progress",
    message: "Launching Chromium against the checked-out TodoMVC application",
  });
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("http://localhost:8000/examples/javascript-es5/");
  await page.locator(".new-todo").fill("Verify the landed change");
  await page.locator(".new-todo").press("Enter");
  await check("Create a todo", (await page.locator(".todo-list li").count()) === 1);
  if (input.requirePersistence) {
    // The example documents in-memory storage; preserve the stronger requirement
    // as a separate probe rather than silently weakening it to pass.
    await page.reload();
    await check(
      "Persistence probe: todo survives reload",
      (await page.locator(".todo-list li").count()) === 1,
    );
  }
  await page.locator(".todo-list .toggle").check();
  await check("Complete a todo", (await page.locator(".todo-list li.completed").count()) === 1);
  await page.locator('a[href="#/active"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".todo-list li").length === 0);
  await check(
    "Active filter excludes completed todo",
    (await page.locator(".todo-list li").count()) === 0,
  );
  await page.locator('a[href="#/completed"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".todo-list li").length === 1);
  await check(
    "Completed filter includes todo",
    (await page.locator(".todo-list li").count()) === 1,
  );
  await page.screenshot({ path: desktop, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: mobile, fullPage: true });
  await check(
    "Mobile page has no horizontal overflow",
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );
  await page.locator(".clear-completed").click();
  await page.waitForFunction(() => document.querySelectorAll(".todo-list li").length === 0);
  await check("Clear completed removes todo", (await page.locator(".todo-list li").count()) === 0);
  await check("No uncaught browser errors", errors.length === 0);
  if (input.forceFailure)
    await check("Intentional negative control (not an upstream defect)", false);
  status = "passed";
} catch (error) {
  status = "failed";
  errors.push(String(error));
  emit({ type: "progress", message: String(error) });
  process.exitCode = 7;
} finally {
  if (page) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: desktop, fullPage: true }).catch(() => {});
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: mobile, fullPage: true }).catch(() => {});
  }
  if (browser) await browser.close();
  await save();
  emit({ type: "artifact", message: "Browser evidence written", path: output });
}
