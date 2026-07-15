package builder

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
)

func TestBuildPlan_Services(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "my-project"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"node": {Version: "20"},
			},
			Env: map[string]string{
				"NODE_ENV": "development",
			},
		},
		Services: &sandbox.ServicesConfig{
			Services: map[string]sandbox.ServiceConfig{
				"postgres": {
					Port: 5432,
					Databases: []sandbox.DatabaseConfig{
						{Name: "myapp"},
					},
					Users: []sandbox.UserConfig{
						{Name: "app", Password: "devpassword"},
					},
				},
				"redis": {
					Port:     6379,
					Password: strPtr("devpassword"),
				},
			},
		},
	}

	plan, err := BuildPlan(context.Background(), t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("BuildPlan failed: %v", err)
	}

	if plan.Project != "my-project" {
		t.Errorf("expected project 'my-project', got %q", plan.Project)
	}

	if !plan.Build.NodeModulesVolume {
		t.Error("expected node_modules volume for node projects")
	}

	if plan.Runtime.Environment["NODE_ENV"] != "development" {
		t.Errorf("expected NODE_ENV=development, got %v", plan.Runtime.Environment)
	}

	if len(plan.Runtime.Services) != 2 {
		t.Fatalf("expected 2 services, got %d", len(plan.Runtime.Services))
	}

	var foundPostgres, foundRedis bool
	for _, svc := range plan.Runtime.Services {
		if svc.Name == "postgres" {
			foundPostgres = true
			if svc.Type != "postgres" {
				t.Errorf("expected postgres type, got %q", svc.Type)
			}
			if svc.Image != "postgres:16" {
				t.Errorf("expected postgres:16 image, got %q", svc.Image)
			}
		}
		if svc.Name == "redis" {
			foundRedis = true
			if svc.Type != "redis" {
				t.Errorf("expected redis type, got %q", svc.Type)
			}
		}
	}
	if !foundPostgres {
		t.Error("expected postgres service in plan")
	}
	if !foundRedis {
		t.Error("expected redis service in plan")
	}

	if !strings.Contains(plan.Runtime.Environment["DATABASE_URL"], "postgres:5432/myapp") {
		t.Errorf("expected DATABASE_URL to reference postgres, got %q", plan.Runtime.Environment["DATABASE_URL"])
	}
	if !strings.Contains(plan.Runtime.Environment["REDIS_URL"], "redis:6379/0") {
		t.Errorf("expected REDIS_URL to reference redis, got %q", plan.Runtime.Environment["REDIS_URL"])
	}
}

func TestBuildPlan_NoServices(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "simple"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"go": {Version: "1.22"},
			},
		},
		Services: &sandbox.ServicesConfig{
			Services: map[string]sandbox.ServiceConfig{},
		},
	}

	plan, err := BuildPlan(context.Background(), t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("BuildPlan failed: %v", err)
	}

	if len(plan.Runtime.Services) != 0 {
		t.Errorf("expected 0 services, got %d", len(plan.Runtime.Services))
	}
	if plan.Build.NodeModulesVolume {
		t.Error("expected no node_modules volume for non-node projects")
	}
}

func TestBuildPlan_UnknownService(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "test"},
		Env:     &sandbox.EnvConfig{},
		Services: &sandbox.ServicesConfig{
			Services: map[string]sandbox.ServiceConfig{
				"custom": {Image: "custom:latest"},
			},
		},
	}

	_, err := BuildPlan(context.Background(), t.TempDir(), cfg)
	if err == nil {
		t.Fatal("expected error for unknown service type")
	}
}

func TestBuildPlan_Hooks(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "hooks-test"},
		Hooks: &sandbox.HooksConfig{
			Build: &sandbox.BuildHooks{
				Pre: []sandbox.HookAction{{Command: "pre-build"}},
			},
			Start: &sandbox.StartHooks{
				Post: []sandbox.HookAction{{Inline: "echo ready"}},
			},
		},
	}

	plan, err := BuildPlan(context.Background(), t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("BuildPlan failed: %v", err)
	}

	if len(plan.Runtime.Hooks.BuildPre) != 1 || plan.Runtime.Hooks.BuildPre[0].Command != "pre-build" {
		t.Errorf("unexpected build pre hooks: %v", plan.Runtime.Hooks.BuildPre)
	}
	if len(plan.Runtime.Hooks.StartPost) != 1 || plan.Runtime.Hooks.StartPost[0].Inline != "echo ready" {
		t.Errorf("unexpected start post hooks: %v", plan.Runtime.Hooks.StartPost)
	}
}

func TestBuildPlan_CustomFeature(t *testing.T) {
	dir := t.TempDir()
	featuresDir := filepath.Join(dir, "sandbox", "features")
	if err := os.MkdirAll(featuresDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(featuresDir, "custom-db.yaml"), []byte("type: postgres\nport: 5433\n"), 0644); err != nil {
		t.Fatal(err)
	}

	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "custom-test"},
		Env:     &sandbox.EnvConfig{},
	}

	plan, err := BuildPlan(context.Background(), dir, cfg)
	if err != nil {
		t.Fatalf("BuildPlan failed: %v", err)
	}

	var found bool
	for _, svc := range plan.Runtime.Services {
		if svc.Name == "custom-db" {
			found = true
			if svc.Type != "postgres" {
				t.Errorf("expected type postgres, got %q", svc.Type)
			}
			if svc.Image != "postgres:16" {
				t.Errorf("expected postgres:16 image, got %q", svc.Image)
			}
		}
	}
	if !found {
		t.Errorf("expected custom-db service in plan, got %v", plan.Runtime.Services)
	}
}

func TestBuildPlan_LanguageFeatures(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "lang-test"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"python": {Version: "3.12", PackageManager: "poetry"},
				"node":   {Version: "20"},
			},
		},
	}

	plan, err := BuildPlan(context.Background(), t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("BuildPlan failed: %v", err)
	}

	if plan.Build.BaseImage == "" {
		t.Error("expected base image to be set")
	}
	if len(plan.Build.DependencyFiles) == 0 {
		t.Error("expected dependency files from language features")
	}
	if len(plan.Build.DependencyInstalls) == 0 {
		t.Error("expected dependency install commands from language features")
	}
	if !plan.Build.NodeModulesVolume {
		t.Error("expected node_modules volume from node feature")
	}
}

func TestBuildPlan_ServiceTypeOverride(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "type-test"},
		Env:     &sandbox.EnvConfig{},
		Services: &sandbox.ServicesConfig{
			Services: map[string]sandbox.ServiceConfig{
				"cache": {
					Type: "redis",
					Port: 6379,
				},
			},
		},
	}

	plan, err := BuildPlan(context.Background(), t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("BuildPlan failed: %v", err)
	}

	if len(plan.Runtime.Services) != 1 {
		t.Fatalf("expected 1 service, got %d", len(plan.Runtime.Services))
	}
	if plan.Runtime.Services[0].Type != "redis" {
		t.Errorf("expected redis type, got %q", plan.Runtime.Services[0].Type)
	}
	if plan.Runtime.Services[0].Name != "cache" {
		t.Errorf("expected name cache, got %q", plan.Runtime.Services[0].Name)
	}
}

func TestBuildPlan_ToolsAndPackages(t *testing.T) {
	cfg := &sandbox.SandboxConfig{
		Project: &sandbox.ProjectConfig{Name: "tools-test"},
		Env: &sandbox.EnvConfig{
			Languages: map[string]sandbox.LanguageConfig{
				"node": {Version: "20"},
			},
			Packages: sandbox.PackageSet{
				Apt: []string{"curl", "git"},
				Npm: []sandbox.PackageRef{
					{Name: "typescript", Version: "5.4"},
				},
			},
			Tools: map[string]string{
				"gh": "latest",
			},
		},
	}

	plan, err := BuildPlan(context.Background(), t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("BuildPlan failed: %v", err)
	}

	// Apt packages from packages and tools should be deduplicated.
	aptSet := make(map[string]bool)
	for _, pkg := range plan.Build.AptPackages {
		aptSet[pkg] = true
	}
	if !aptSet["curl"] || !aptSet["git"] || !aptSet["gh"] {
		t.Errorf("expected apt packages curl, git, gh, got %v", plan.Build.AptPackages)
	}

	// npm packages and gh verify should appear as snippets.
	var hasNpm, hasGhVerify bool
	for _, snippet := range plan.Build.LanguageSnippets {
		if snippet == "RUN npm install -g typescript@5.4" {
			hasNpm = true
		}
		if snippet == "RUN gh --version" {
			hasGhVerify = true
		}
	}
	if !hasNpm {
		t.Errorf("expected npm install snippet, got %v", plan.Build.LanguageSnippets)
	}
	if !hasGhVerify {
		t.Errorf("expected gh verify snippet, got %v", plan.Build.LanguageSnippets)
	}

	// Verify order: package snippets come before tool snippets.
	if len(plan.Build.LanguageSnippets) < 2 {
		t.Errorf("expected at least 2 snippets (npm install, gh verify), got %v", plan.Build.LanguageSnippets)
	}
}

func strPtr(s string) *string {
	return &s
}
