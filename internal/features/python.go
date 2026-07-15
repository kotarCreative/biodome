package features

import (
	"context"
	"fmt"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

// PythonFeature contributes a Python runtime to the sandbox.
type PythonFeature struct {
	name string
	cfg  sandbox.LanguageConfig
}

func newPythonFeature(name string, raw any) (feature.Feature, error) {
	cfg, ok := raw.(sandbox.LanguageConfig)
	if !ok {
		return nil, fmt.Errorf("python: expected sandbox.LanguageConfig, got %T", raw)
	}
	return &PythonFeature{name: name, cfg: cfg}, nil
}

func (f *PythonFeature) Name() string { return f.name }
func (f *PythonFeature) Type() string { return "language" }
func (f *PythonFeature) Config() any  { return f.cfg }

func (f *PythonFeature) Validate() []error {
	return nil
}

func (f *PythonFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	if plan.Build.BaseImage == "" {
		plan.Build.BaseImage = fmt.Sprintf("python:%s-slim", f.cfg.Version)
	}

	if f.cfg.PackageManager == "poetry" {
		plan.Build.LanguageSnippets = append(plan.Build.LanguageSnippets,
			"RUN pip install --no-cache-dir poetry")

		plan.Build.DependencyFiles = append(plan.Build.DependencyFiles,
			"pyproject.toml", "poetry.lock")

		plan.Build.DependencyInstalls = append(plan.Build.DependencyInstalls, feature.DependencyInstall{
			Files: []string{"pyproject.toml", "poetry.lock"},
			Command: `RUN --mount=type=cache,target=/root/.cache/pip \
    poetry config virtualenvs.in-project true && \
    poetry install --no-root && \
    poetry cache clear --all pypi && \
    pip cache purge`,
		})

		plan.Build.CopyArtifacts = append(plan.Build.CopyArtifacts, feature.CopyArtifact{
			Files: []string{"pyproject.toml", "poetry.lock"},
			Lines: []string{"COPY --from=deps /workspace/.venv /workspace/.venv"},
		})

		plan.Build.Environment["PATH"] = "/workspace/.venv/bin:$PATH"
	} else {
		plan.Build.DependencyFiles = append(plan.Build.DependencyFiles, "requirements.txt")

		plan.Build.DependencyInstalls = append(plan.Build.DependencyInstalls, feature.DependencyInstall{
			Files: []string{"requirements.txt"},
			Command: `RUN --mount=type=cache,target=/root/.cache/pip \
    python -m venv /workspace/.venv && \
    /workspace/.venv/bin/pip install --no-cache-dir -r requirements.txt && \
    pip cache purge`,
		})

		plan.Build.CopyArtifacts = append(plan.Build.CopyArtifacts, feature.CopyArtifact{
			Files: []string{"requirements.txt"},
			Lines: []string{"COPY --from=deps /workspace/.venv /workspace/.venv"},
		})

		plan.Build.Environment["PATH"] = "/workspace/.venv/bin:$PATH"
	}

	_ = ctx
	return nil
}
