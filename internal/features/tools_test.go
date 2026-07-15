package features

import (
	"context"
	"testing"

	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

func TestToolFeature(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("gh", "gh", "latest")
	if err != nil {
		t.Fatalf("Create gh failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	found := false
	for _, pkg := range plan.Build.AptPackages {
		if pkg == "gh" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected gh apt package, got %v", plan.Build.AptPackages)
	}

	var hasVerify bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN gh --version" {
			hasVerify = true
		}
	}
	if !hasVerify {
		t.Errorf("expected gh verify snippet, got %v", plan.Build.LanguageSnippets)
	}
}

func TestToolFeatureScript(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("kubectl", "kubectl", "latest")
	if err != nil {
		t.Fatalf("Create kubectl failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	var hasScript bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN curl -fsSL https://dl.k8s.io/release/stable.txt > /tmp/kubectl-version && curl -fsSL https://dl.k8s.io/release/$(cat /tmp/kubectl-version)/bin/linux/amd64/kubectl -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl" {
			hasScript = true
		}
	}
	if !hasScript {
		t.Errorf("expected kubectl install script, got %v", plan.Build.LanguageSnippets)
	}
}

func TestRegisterTool(t *testing.T) {
	r := NewRegistry()
	RegisterTool(r, "my-tool", ToolDefinition{
		AptPackages: []string{"my-package"},
		Verify:      "my-tool --version",
	})

	feat, err := r.Create("my-tool", "my-tool", "1.0")
	if err != nil {
		t.Fatalf("Create my-tool failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}
	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	found := false
	for _, pkg := range plan.Build.AptPackages {
		if pkg == "my-package" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected my-package apt package, got %v", plan.Build.AptPackages)
	}
}
