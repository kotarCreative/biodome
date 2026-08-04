import { ValidationError } from "../core/errors.js";

export interface AppGraphNode {
  name: string;
  dependencies: string[];
}

/** Returns dependency-first deterministic order and fails before any expansion. */
export function sortApplications(nodes: AppGraphNode[]): string[] {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!byName.has(dependency)) {
        throw new ValidationError({
          message: `Application "${node.name}" references unknown application "${dependency}"`,
        });
      }
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  const visit = (name: string, trail: string[]): void => {
    const status = state.get(name);
    if (status === "done") return;
    if (status === "visiting") {
      const start = trail.indexOf(name);
      const cycle = [...trail.slice(start), name];
      throw new ValidationError({ message: `Application dependency cycle: ${cycle.join(" -> ")}` });
    }
    state.set(name, "visiting");
    const node = byName.get(name)!;
    for (const dependency of [...node.dependencies].sort()) visit(dependency, [...trail, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of [...byName.keys()].sort()) visit(name, []);
  return order;
}
