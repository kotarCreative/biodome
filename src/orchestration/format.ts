import type { CompatibilityIssue, CompatibilityReport } from "./compatibility.js";

function formatIssue(issue: CompatibilityIssue): string {
  return issue.reason ? `  - ${issue.subject}: ${issue.reason}` : `  - ${issue.subject}`;
}

/**
 * Produce stable, plain-text output suitable for the CLI's `plan` command.
 * It intentionally contains no terminal colour codes so it is useful in CI
 * logs as well as interactive terminals.
 */
export function formatCompatibilityReport(report: CompatibilityReport): string {
  const lines = [
    `Provider: ${report.provider}`,
    `Compatibility: ${report.compatible ? "compatible" : "incompatible"}`,
  ];

  if (report.missing.length > 0) {
    lines.push("Missing required capabilities:", ...report.missing.map(formatIssue));
  }
  if (report.warnings.length > 0) {
    lines.push("Warnings:", ...report.warnings.map(formatIssue));
  }
  if (report.missing.length === 0 && report.warnings.length === 0) {
    lines.push("All declared requirements are supported.");
  }
  if (report.supported.length > 0) {
    lines.push(`Supported capabilities: ${[...report.supported].sort().join(", ")}`);
  }

  return lines.join("\n");
}
