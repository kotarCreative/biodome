package features

import "github.com/anomalyco/sandbox-manager/pkg/feature"

// addAptPackage adds a unique apt package to the build plan.
func addAptPackage(plan *feature.Plan, pkgs ...string) {
	seen := make(map[string]struct{}, len(plan.Build.AptPackages))
	for _, pkg := range plan.Build.AptPackages {
		seen[pkg] = struct{}{}
	}
	for _, pkg := range pkgs {
		if _, ok := seen[pkg]; ok {
			continue
		}
		seen[pkg] = struct{}{}
		plan.Build.AptPackages = append(plan.Build.AptPackages, pkg)
	}
}

// addLanguageSnippet adds a Dockerfile snippet to the build plan.
func addLanguageSnippet(plan *feature.Plan, snippets ...string) {
	plan.Build.LanguageSnippets = append(plan.Build.LanguageSnippets, snippets...)
}
