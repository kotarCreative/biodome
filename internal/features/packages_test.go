package features

import (
	"context"
	"testing"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

func TestAptPackagesFeature(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("apt-packages", "apt-packages", []string{"curl", "git", "jq"})
	if err != nil {
		t.Fatalf("Create apt-packages failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	if len(plan.Build.AptPackages) != 3 {
		t.Errorf("expected 3 apt packages, got %v", plan.Build.AptPackages)
	}
}

func TestNpmPackagesFeature(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("npm-packages", "npm-packages", []sandbox.PackageRef{
		{Name: "typescript", Version: "5.4"},
		{Name: "vite"},
	})
	if err != nil {
		t.Fatalf("Create npm-packages failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	var found bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN npm install -g typescript@5.4 vite" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected npm install snippet, got %v", plan.Build.LanguageSnippets)
	}
}

func TestPipPackagesFeature(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("pip-packages", "pip-packages", []sandbox.PackageRef{
		{Name: "pytest", Version: "8.0"},
		{Name: "black"},
	})
	if err != nil {
		t.Fatalf("Create pip-packages failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	var found bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN pip install --no-cache-dir pytest==8.0 black" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected pip install snippet, got %v", plan.Build.LanguageSnippets)
	}
}

func TestGoPackagesFeature(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("go-packages", "go-packages", []string{"golang.org/x/tools"})
	if err != nil {
		t.Fatalf("Create go-packages failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	var found bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN go install golang.org/x/tools" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected go install snippet, got %v", plan.Build.LanguageSnippets)
	}
}

func TestNixPackagesFeature(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("nix-packages", "nix-packages", []string{"ripgrep", "fd"})
	if err != nil {
		t.Fatalf("Create nix-packages failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	var found bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN . /root/.nix-profile/etc/profile.d/nix.sh && nix profile install nixpkgs#ripgrep nixpkgs#fd" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected nix install snippet, got %v", plan.Build.LanguageSnippets)
	}
}

func TestCargoPackagesFeature(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("cargo-packages", "cargo-packages", []string{"bat"})
	if err != nil {
		t.Fatalf("Create cargo-packages failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	var found bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN cargo install bat" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected cargo install snippet, got %v", plan.Build.LanguageSnippets)
	}
}

func TestGemPackagesFeature(t *testing.T) {
	r := NewRegistry()
	feat, err := r.Create("gem-packages", "gem-packages", []string{"rails"})
	if err != nil {
		t.Fatalf("Create gem-packages failed: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	var found bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN gem install rails" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected gem install snippet, got %v", plan.Build.LanguageSnippets)
	}
}
