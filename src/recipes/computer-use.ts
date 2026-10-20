import { isAppEndpointReference } from "../apps/references.js";
import { defineAppRecipe } from "../apps/recipe.js";
import { APP_RECIPE_API_VERSION, type AppEndpointReference } from "../apps/types.js";
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
