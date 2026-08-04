import type { Application, Plan } from "../core/plan.js";

export function appSummary(plan: Plan): Array<{
  name: string;
  recipe: string;
  repositories: number;
  processes: number;
  endpoints: number;
}> {
  return [...plan.runtime.applications]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((application) => ({
      name: application.name,
      recipe: application.recipe
        ? `${application.recipe.id}${application.recipe.version ? `@${application.recipe.version}` : ""}`
        : "local",
      repositories: application.repositories.length,
      processes: application.processes.length,
      endpoints: application.endpoints.length,
    }));
}

function columns(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((value, column) => value.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatAppList(plan: Plan): string {
  const rows = appSummary(plan);
  if (rows.length === 0) return "No applications declared\n";
  return (
    columns([
      ["APP", "RECIPE", "REPOSITORIES", "PROCESSES", "ENDPOINTS"],
      ...rows.map((row) => [
        row.name,
        row.recipe,
        String(row.repositories),
        String(row.processes),
        String(row.endpoints),
      ]),
    ]) + "\n"
  );
}

export interface AppInspection extends Application {
  contributions: Plan["runtime"]["contributions"];
}

export function appInspection(plan: Plan, name: string): AppInspection {
  const application = plan.runtime.applications.find((entry) => entry.name === name);
  if (!application) {
    const available = plan.runtime.applications.map((entry) => entry.name).sort();
    throw new Error(
      `Unknown application "${name}". Available applications: ${available.join(", ") || "(none)"}`,
    );
  }
  return {
    ...application,
    contributions: plan.runtime.contributions.filter(
      (contribution) => contribution.source.application === application.name,
    ),
  };
}

export function formatAppInspection(plan: Plan, name: string): string {
  const detail = appInspection(plan, name);
  const lines = [
    `Application: ${detail.name}`,
    `Root: ${detail.root}`,
    `Declaration: ${detail.declarationPath}`,
  ];
  if (detail.recipe)
    lines.push(
      `Recipe: ${detail.recipe.id}${detail.recipe.version ? `@${detail.recipe.version}` : ""}`,
    );
  for (const [label, values] of [
    ["Dependencies", detail.dependencies],
    ["Required services", detail.requiredServices],
    ["Repositories", detail.repositories],
    ["Hooks", detail.hooks],
    ["Processes", detail.processes],
    ["Endpoints", detail.endpoints],
  ] as const) {
    lines.push("");
    lines.push(`${label}:`);
    if (values.length === 0) lines.push("  (none)");
    else for (const value of values) lines.push(`  - ${value}`);
  }
  lines.push("");
  lines.push("Contributions:");
  if (detail.contributions.length === 0) lines.push("  (none)");
  else
    for (const contribution of detail.contributions)
      lines.push(`  - ${contribution.kind}: ${contribution.qualifiedName}`);
  return lines.join("\n") + "\n";
}
