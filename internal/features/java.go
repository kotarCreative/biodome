package features

import (
	"context"
	"fmt"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

// JavaFeature contributes a Java runtime to the sandbox.
type JavaFeature struct {
	name string
	cfg  sandbox.LanguageConfig
}

func newJavaFeature(name string, raw any) (feature.Feature, error) {
	cfg, ok := raw.(sandbox.LanguageConfig)
	if !ok {
		return nil, fmt.Errorf("java: expected sandbox.LanguageConfig, got %T", raw)
	}
	return &JavaFeature{name: name, cfg: cfg}, nil
}

func (f *JavaFeature) Name() string { return f.name }
func (f *JavaFeature) Type() string { return "language" }
func (f *JavaFeature) Config() any  { return f.cfg }

func (f *JavaFeature) Validate() []error {
	return nil
}

func (f *JavaFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if plan.Build.BaseImage == "" {
		plan.Build.BaseImage = fmt.Sprintf("eclipse-temurin:%s-jdk", f.cfg.Version)
	}

	_ = ctx
	return nil
}
