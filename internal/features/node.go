package features

import (
	"context"
	"fmt"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

// NodeFeature contributes a Node.js runtime to the sandbox.
type NodeFeature struct {
	name string
	cfg  sandbox.LanguageConfig
}

func newNodeFeature(name string, raw any) (feature.Feature, error) {
	cfg, ok := raw.(sandbox.LanguageConfig)
	if !ok {
		return nil, fmt.Errorf("node: expected sandbox.LanguageConfig, got %T", raw)
	}
	return &NodeFeature{name: name, cfg: cfg}, nil
}

func (f *NodeFeature) Name() string { return f.name }
func (f *NodeFeature) Type() string { return "language" }
func (f *NodeFeature) Config() any  { return f.cfg }

func (f *NodeFeature) Validate() []error {
	return nil
}

func (f *NodeFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	// Base image is set by the first language; node only sets it if empty.
	if plan.Build.BaseImage == "" {
		plan.Build.BaseImage = fmt.Sprintf("node:%s-slim", f.cfg.Version)
	}

	// Language setup in the base stage.
	switch f.cfg.PackageManager {
	case "pnpm":
		plan.Build.LanguageSnippets = append(plan.Build.LanguageSnippets,
			"RUN corepack enable && corepack prepare pnpm@latest --activate")
	case "yarn":
		plan.Build.LanguageSnippets = append(plan.Build.LanguageSnippets,
			"RUN corepack enable && corepack prepare yarn@stable --activate")
	}

	// Dependency files.
	files := []string{"package.json"}
	switch f.cfg.PackageManager {
	case "pnpm":
		files = append(files, "pnpm-lock.yaml")
	case "yarn":
		files = append(files, "yarn.lock")
	default:
		files = append(files, "package-lock.json")
	}
	plan.Build.DependencyFiles = append(plan.Build.DependencyFiles, files...)

	// Dependency install commands.
	switch f.cfg.PackageManager {
	case "pnpm":
		plan.Build.DependencyInstalls = append(plan.Build.DependencyInstalls, feature.DependencyInstall{
			Files: []string{"package.json", "pnpm-lock.yaml"},
			Command: `RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && pnpm store prune`,
		})
	case "yarn":
		plan.Build.DependencyInstalls = append(plan.Build.DependencyInstalls, feature.DependencyInstall{
			Files: []string{"package.json", "yarn.lock"},
			Command: `RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile && yarn cache clean`,
		})
	default:
		plan.Build.DependencyInstalls = append(plan.Build.DependencyInstalls,
			feature.DependencyInstall{
				Files: []string{"package-lock.json"},
				Command: `RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline && npm cache clean --force`,
			},
			feature.DependencyInstall{
				Files: []string{"package.json"},
				Command: `RUN --mount=type=cache,target=/root/.npm \
    npm install && npm cache clean --force`,
			},
		)
	}

	// Copy artifacts for the final stage.
	plan.Build.CopyArtifacts = append(plan.Build.CopyArtifacts, feature.CopyArtifact{
		Files: []string{"package.json"},
		Lines: []string{"COPY --from=deps /workspace/node_modules /workspace/node_modules"},
	})

	plan.Build.NodeModulesVolume = true

	_ = ctx
	return nil
}
