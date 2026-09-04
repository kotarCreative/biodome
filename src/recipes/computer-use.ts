import { isAppEndpointReference } from "../apps/references.js";
import { defineAppRecipe } from "../apps/recipe.js";
import { APP_RECIPE_API_VERSION, type AppEndpointReference } from "../apps/types.js";
import type { TaskSpec } from "../core/plan.js";
import { AGENT_BROWSER_VERSION } from "../core/tools.js";

const RECIPE_VERSION = "0.1.0";
const ARTIFACT_DIR = "/workspace/qa";
const DOMAIN_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const ALLOWED_DOMAIN_PATTERN = new RegExp(`^(?:\\*\\.)?${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`);

export const COMPUTER_USE_ARTIFACTS = Object.freeze([
  "qa/report.md",
  "qa/result.json",
  "qa/desktop.png",
  "qa/mobile.png",
  "qa/session.webm",
  "qa/network.har",
  "qa/trace.json",
  "qa/accessibility.json",
  "qa/console.json",
  "qa/errors.json",
] as const);

export interface ComputerUseOptions {
  /** URL reachable from inside the Biodome runtime, such as http://localhost:3000. */
  baseUrl: string;
  /** Optional app dependency used to verify and order the endpoint under test. */
  target?: AppEndpointReference;
  /** Optional agent-browser navigation allowlist. Supports entries such as *.example.com. */
  allowedDomains?: readonly string[];
  /** Run Chrome under Xvfb instead of using its default headless mode. */
  headed?: boolean;
}

export interface ManualQaTaskOptions {
  harness: string;
  /** The branch-specific user journeys, regression risks, and acceptance criteria to test. */
  instructions: string;
  timeout?: string;
  requiredServices?: string[];
  requiredProcesses?: string[];
}

function validateOptions(options: ComputerUseOptions): void {
  if (
    !options ||
    typeof options !== "object" ||
    typeof options.baseUrl !== "string" ||
    !options.baseUrl ||
    options.baseUrl.trim() !== options.baseUrl
  ) {
    throw new Error("Computer-use recipe requires a non-empty baseUrl");
  }
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new Error(`Computer-use recipe baseUrl must be an absolute URL: ${options.baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Computer-use recipe baseUrl must use http or https");
  }
  if (options.allowedDomains !== undefined && !Array.isArray(options.allowedDomains)) {
    throw new Error("Computer-use recipe allowedDomains must be an array");
  }
  for (const domain of options.allowedDomains ?? []) {
    if (
      typeof domain !== "string" ||
      domain.trim() !== domain ||
      !ALLOWED_DOMAIN_PATTERN.test(domain)
    ) {
      throw new Error(`Computer-use recipe has an invalid allowed domain: ${domain}`);
    }
  }
  if (
    options.allowedDomains?.length &&
    !options.allowedDomains.some((domain) => {
      if (!domain.startsWith("*.")) return domain.toLowerCase() === url.hostname.toLowerCase();
      return url.hostname.toLowerCase().endsWith(`.${domain.slice(2).toLowerCase()}`);
    })
  ) {
    throw new Error(
      `Computer-use recipe allowedDomains must include the baseUrl host: ${url.hostname}`,
    );
  }
  if (options.headed !== undefined && typeof options.headed !== "boolean") {
    throw new Error("Computer-use recipe headed option must be a boolean");
  }
  if (options.target !== undefined && !isAppEndpointReference(options.target)) {
    throw new Error(
      "Computer-use recipe target must be an app endpoint reference created with app(...).endpoint(...)",
    );
  }
}

/** Installs and configures browser automation for exploratory, agent-driven QA. */
export const computerUse = defineAppRecipe<ComputerUseOptions>({
  id: "@kotarcreative/biodome/recipes/computer-use",
  version: RECIPE_VERSION,
  apiVersion: APP_RECIPE_API_VERSION,
  expand(app, options) {
    validateOptions(options);
    if (options.target) app.requireAppEndpoint(options.target);

    app.addTool("agent-browser", { version: AGENT_BROWSER_VERSION });

    app.addEnvironment("BIODOME_QA_BASE_URL", { value: options.baseUrl });
    app.addEnvironment("BIODOME_QA_ARTIFACT_DIR", { value: ARTIFACT_DIR });
    app.addEnvironment("AGENT_BROWSER_EXECUTABLE_PATH", {
      value: "/usr/local/bin/biodome-chromium",
    });
    app.addEnvironment("AGENT_BROWSER_ARGS", {
      value: "--no-sandbox,--disable-dev-shm-usage",
    });
    app.addEnvironment("AGENT_BROWSER_SESSION", { value: "biodome-qa" });
    app.addEnvironment("AGENT_BROWSER_CONTENT_BOUNDARIES", { value: "1" });
    app.addEnvironment("AGENT_BROWSER_MAX_OUTPUT", { value: "50000" });
    app.addEnvironment("AGENT_BROWSER_HIDE_SCROLLBARS", { value: "1" });
    app.addEnvironment("AGENT_BROWSER_COLOR_SCHEME", { value: "light" });
    app.addEnvironment("AGENT_BROWSER_SCREENSHOT_DIR", { value: ARTIFACT_DIR });
    app.addEnvironment("AGENT_BROWSER_DOWNLOAD_PATH", { value: `${ARTIFACT_DIR}/downloads` });
    if (options.allowedDomains?.length) {
      app.addEnvironment("AGENT_BROWSER_ALLOWED_DOMAINS", {
        value: options.allowedDomains.join(","),
      });
    }
    if (options.headed) app.addEnvironment("AGENT_BROWSER_HEADED", { value: "1" });
  },
});

const QA_PROMPT = `Perform manual browser QA against the current branch. Do not modify application source code or hide product failures.

The application URL is in BIODOME_QA_BASE_URL. Use the agent-browser CLI and its fixed biodome-qa session. Start by removing /workspace/qa, recreating /workspace/qa/downloads, and closing stale agent-browser sessions.

Exercise the requested journeys as a user would. Use accessibility snapshots to choose elements and re-snapshot after navigation or major UI changes. Check both a 1440x900 desktop viewport and a 390x844 mobile viewport. Inspect page errors, console output, network behavior, loading and empty states, keyboard interaction, and an agent-browser accessibility audit. Do not treat a product defect as an agent execution failure: continue collecting evidence and report the QA result as failed.

Capture the complete session. Start video, HAR, and trace recording in that order before navigating to the application (open the application URL directly; agent-browser does not accept blank pages such as about:blank):
- Record the full test as qa/session.webm and stop it before closing the browser.
- Save a metadata-only HAR as qa/network.har.
- Save the most relevant journey or failure reproduction as qa/trace.json. Stop tracing as soon as that flow completes because Chrome traces grow quickly.
- Save full-page final-state screenshots as qa/desktop.png and qa/mobile.png.
- Save JSON output from the accessibility audit, console, and page errors as qa/accessibility.json, qa/console.json, and qa/errors.json. When a page produced no console messages or page errors, agent-browser prints nothing for that stream; write [] (an empty JSON array) to the corresponding file instead of leaving it empty.

Write qa/result.json with this shape: {"status":"passed|failed|blocked","baseUrl":"...","summary":"...","scenarios":[{"name":"...","status":"passed|failed|blocked","evidence":["qa/..."],"notes":"..."}],"issues":[{"severity":"critical|high|medium|low","title":"...","steps":["..."],"expected":"...","actual":"...","evidence":["qa/..."]}]}. Write qa/report.md as a concise human-readable report with scope, environment, scenario results, issues, and links to every evidence artifact.

Stop trace, HAR, and video explicitly so files are flushed, then close the browser. Write result.json and report.md last. Before finishing, run test -s for every declared artifact in /workspace/qa; every file must exist and be non-empty.`;

/** Creates the task declaration paired with the computer-use app recipe. */
export function manualQaTask(options: ManualQaTaskOptions): TaskSpec {
  if (!options.harness?.trim()) throw new Error("Manual QA task requires a harness");
  if (!options.instructions?.trim()) throw new Error("Manual QA task requires instructions");

  return {
    harness: options.harness,
    prompt: `${QA_PROMPT}\n\nBranch-specific QA assignment:\n${options.instructions}`,
    artifacts: [...COMPUTER_USE_ARTIFACTS],
    timeout: options.timeout ?? "30m",
    cleanup: "always",
    requiredServices: options.requiredServices,
    requiredProcesses: options.requiredProcesses,
  };
}
