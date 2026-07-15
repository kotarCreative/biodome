package features

import (
	"context"
	"fmt"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

// GoFeature contributes a Go runtime to the sandbox.
type GoFeature struct {
	name string
	cfg  sandbox.LanguageConfig
}

func newGoFeature(name string, raw any) (feature.Feature, error) {
	cfg, ok := raw.(sandbox.LanguageConfig)
	if !ok {
		return nil, fmt.Errorf("go: expected sandbox.LanguageConfig, got %T", raw)
	}
	return &GoFeature{name: name, cfg: cfg}, nil
}

func (f *GoFeature) Name() string { return f.name }
func (f *GoFeature) Type() string { return "language" }
func (f *GoFeature) Config() any  { return f.cfg }

func (f *GoFeature) Validate() []error {
	return nil
}

func (f *GoFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if plan.Build.BaseImage == "" {
		plan.Build.BaseImage = fmt.Sprintf("golang:%s-alpine", f.cfg.Version)
	}

	if f.cfg.CgoEnabled != nil && !*f.cfg.CgoEnabled {
		plan.Build.LanguageSnippets = append(plan.Build.LanguageSnippets, "ENV CGO_ENABLED=0")
	}

	plan.Build.DependencyFiles = append(plan.Build.DependencyFiles, "go.mod", "go.sum")

	plan.Build.DependencyInstalls = append(plan.Build.DependencyInstalls, feature.DependencyInstall{
		Files: []string{"go.mod"},
		Command: `RUN --mount=type=cache,target=/go/pkg/mod \
    mkdir -p /workspace/go-mod && \
    go mod download && \
    (cp -r /go/pkg/mod/. /workspace/go-mod/ 2>/dev/null || true) && \
    go clean -cache`,
	})

	plan.Build.CopyArtifacts = append(plan.Build.CopyArtifacts, feature.CopyArtifact{
		Files: []string{"go.mod"},
		Lines: []string{"COPY --from=deps /workspace/go-mod /go/pkg/mod"},
	})

	_ = ctx
	return nil
}
