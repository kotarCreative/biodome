// Package graph provides topological sorting for service dependency trees.
// It is used by the supervisor to start independent services in parallel while
// respecting depends_on relationships.
package graph

import (
	"errors"
	"fmt"
	"sort"
)

// Graph is a dependency graph where each node is a service name and its edges
// point to the services it depends on.
type Graph struct {
	nodes map[string][]string
}

// New creates a graph from a map of node names to their dependencies.
func New(nodes map[string][]string) *Graph {
	return &Graph{nodes: nodes}
}

// Sort returns a topological ordering of all nodes. If the graph contains a
// cycle, it returns an error.
func (g *Graph) Sort() ([]string, error) {
	visited := make(map[string]bool)
	visiting := make(map[string]bool)
	order := make([]string, 0, len(g.nodes))

	var visit func(name string) error
	visit = func(name string) error {
		if visiting[name] {
			return fmt.Errorf("dependency cycle detected at %q", name)
		}
		if visited[name] {
			return nil
		}
		visiting[name] = true
		for _, dep := range g.nodes[name] {
			if _, ok := g.nodes[dep]; !ok {
				return fmt.Errorf("unknown dependency %q for service %q", dep, name)
			}
			if err := visit(dep); err != nil {
				return err
			}
		}
		visiting[name] = false
		visited[name] = true
		order = append(order, name)
		return nil
	}

	names := make([]string, 0, len(g.nodes))
	for name := range g.nodes {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		if err := visit(name); err != nil {
			return nil, err
		}
	}

	return order, nil
}

// Waves returns the nodes grouped into waves. All services in a wave can be
// started in parallel because their dependencies are in earlier waves.
func (g *Graph) Waves() ([][]string, error) {
	order, err := g.Sort()
	if err != nil {
		return nil, err
	}

	depth := make(map[string]int)
	for _, name := range order {
		maxDepth := 0
		for _, dep := range g.nodes[name] {
			if d, ok := depth[dep]; ok && d+1 > maxDepth {
				maxDepth = d + 1
			}
		}
		depth[name] = maxDepth
	}

	maxWave := 0
	for _, d := range depth {
		if d > maxWave {
			maxWave = d
		}
	}

	waves := make([][]string, maxWave+1)
	for _, name := range order {
		waves[depth[name]] = append(waves[depth[name]], name)
	}

	return waves, nil
}

// CollectErrors is a small helper that joins a slice of errors into a single
// error with context.
func CollectErrors(errs []error) error {
	if len(errs) == 0 {
		return nil
	}
	return errors.Join(errs...)
}
