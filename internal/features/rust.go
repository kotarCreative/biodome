package features

import (
	"context"
	"fmt"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

// RustFeature contributes a Rust runtime to the sandbox.
type RustFeature struct {
	name string
	cfg  sandbox.LanguageConfig
}

func newRustFeature(name string, raw any) (feature.Feature, error) {
	cfg, ok := raw.(sandbox.LanguageConfig)
	if !ok {
		return nil, fmt.Errorf("rust: expected sandbox.LanguageConfig, got %T", raw)
	}
	return &RustFeature{name: name, cfg: cfg}, nil
}

func (f *RustFeature) Name() string { return f.name }
func (f *RustFeature) Type() string { return "language" }
func (f *RustFeature) Config() any  { return f.cfg }

func (f *RustFeature) Validate() []error {
	return nil
}

func (f *RustFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if plan.Build.BaseImage == "" {
		plan.Build.BaseImage = fmt.Sprintf("rust:%s-slim", f.cfg.Version)
	}

	plan.Build.DependencyFiles = append(plan.Build.DependencyFiles, "Cargo.toml", "Cargo.lock")

	plan.Build.DependencyInstalls = append(plan.Build.DependencyInstalls, feature.DependencyInstall{
		Files: []string{"Cargo.toml"},
		Command: `RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo fetch && \
    rm -rf /usr/local/cargo/registry/cache`,
	})

	plan.Build.CopyArtifacts = append(plan.Build.CopyArtifacts, feature.CopyArtifact{
		Files: []string{"Cargo.toml"},
		Lines: []string{
			"COPY --from=deps /usr/local/cargo/registry /usr/local/cargo/registry",
			"COPY --from=deps /workspace/target /workspace/target",
		},
	})

	_ = ctx
	return nil
}
