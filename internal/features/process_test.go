package features

import (
	"context"
	"testing"

	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

func TestNewProcessFeature(t *testing.T) {
	r := NewRegistry()

	feat, err := r.Create("process", "django", map[string]any{
		"command": []string{"python", "manage.py", "runserver", "0.0.0.0:8000"},
		"port":    8000,
		"healthcheck": map[string]any{
			"type": "http",
			"url":  "http://localhost:8000/admin/login/",
		},
	})
	if err != nil {
		t.Fatalf("create process feature: %v", err)
	}
	if feat.Name() != "django" {
		t.Errorf("name: want %q, got %q", "django", feat.Name())
	}
	if feat.Type() != "process" {
		t.Errorf("type: want %q, got %q", "process", feat.Type())
	}
}

func TestProcessFeatureContributes(t *testing.T) {
	feat, err := newProcessFeature("django", map[string]any{
		"command": []string{"python", "manage.py", "runserver", "0.0.0.0:8000"},
		"port":    8000,
	})
	if err != nil {
		t.Fatalf("create process feature: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
		Runtime: feature.RuntimePlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("contribute: %v", err)
	}

	if len(plan.Runtime.Processes) != 1 {
		t.Fatalf("expected 1 process, got %d", len(plan.Runtime.Processes))
	}
	proc := plan.Runtime.Processes[0]
	if proc.Name != "django" {
		t.Errorf("process name: want %q, got %q", "django", proc.Name)
	}
	if len(proc.Command) != 4 || proc.Command[0] != "python" {
		t.Errorf("unexpected command: %v", proc.Command)
	}
	if len(proc.Ports) != 1 || proc.Ports[0].Host != 8000 || proc.Ports[0].Container != 8000 {
		t.Errorf("unexpected ports: %v", proc.Ports)
	}
}

func TestProcessFeatureCommandString(t *testing.T) {
	feat, err := newProcessFeature("server", map[string]any{
		"command": "npm run dev",
		"port":    3000,
	})
	if err != nil {
		t.Fatalf("create process feature: %v", err)
	}

	pf, ok := feat.(*ProcessFeature)
	if !ok {
		t.Fatalf("expected *ProcessFeature, got %T", feat)
	}
	cmd, err := pf.command()
	if err != nil {
		t.Fatalf("command: %v", err)
	}
	want := []string{"sh", "-c", "npm run dev"}
	if len(cmd) != len(want) || cmd[0] != want[0] || cmd[2] != want[2] {
		t.Errorf("command: want %v, got %v", want, cmd)
	}
}

func TestProcessFeatureHealthCheckDefaults(t *testing.T) {
	feat, err := newProcessFeature("server", map[string]any{
		"command": []string{"node", "server.js"},
		"port":    3000,
	})
	if err != nil {
		t.Fatalf("create process feature: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
		Runtime: feature.RuntimePlan{
			Environment: make(map[string]string),
		},
	}
	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("contribute: %v", err)
	}

	proc := plan.Runtime.Processes[0]
	if proc.HealthCheck != nil {
		t.Fatalf("expected no health check without healthcheck config")
	}
}

func TestProcessFeatureHealthCheckFromURL(t *testing.T) {
	feat, err := newProcessFeature("server", map[string]any{
		"command": []string{"node", "server.js"},
		"port":    3000,
		"healthcheck": map[string]any{
			"url": "http://localhost:3000/health",
		},
	})
	if err != nil {
		t.Fatalf("create process feature: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
		Runtime: feature.RuntimePlan{
			Environment: make(map[string]string),
		},
	}
	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("contribute: %v", err)
	}

	if len(plan.Build.AptPackages) == 0 || plan.Build.AptPackages[0] != "curl" {
		t.Errorf("expected curl apt package for http health check, got %v", plan.Build.AptPackages)
	}

	proc := plan.Runtime.Processes[0]
	if proc.HealthCheck == nil {
		t.Fatalf("expected health check")
	}
	if proc.HealthCheck.URL != "http://localhost:3000/health" {
		t.Errorf("health check url: want %q, got %q", "http://localhost:3000/health", proc.HealthCheck.URL)
	}
	if proc.HealthCheck.Type != "http" {
		t.Errorf("health check type: want %q, got %q", "http", proc.HealthCheck.Type)
	}
}

func TestProcessFeatureEnvironment(t *testing.T) {
	feat, err := newProcessFeature("django", map[string]any{
		"command": []string{"python", "manage.py", "runserver"},
		"env": map[string]any{
			"DEBUG": "1",
		},
	})
	if err != nil {
		t.Fatalf("create process feature: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
		Runtime: feature.RuntimePlan{
			Environment: make(map[string]string),
		},
	}
	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("contribute: %v", err)
	}

	if plan.Runtime.Environment["DEBUG"] != "1" {
		t.Errorf("expected env DEBUG=1, got %v", plan.Runtime.Environment)
	}
}

func TestProcessFeatureMCP(t *testing.T) {
	feat, err := newProcessFeature("opencode-mcp", map[string]any{
		"command": []string{"node", "mcp-server.js"},
		"port":    3001,
	})
	if err != nil {
		t.Fatalf("create process feature: %v", err)
	}

	plan := &feature.Plan{
		Build: feature.BuildPlan{
			Environment: make(map[string]string),
		},
		Runtime: feature.RuntimePlan{
			Environment: make(map[string]string),
		},
	}
	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("contribute: %v", err)
	}

	proc := plan.Runtime.Processes[0]
	if proc.Name != "opencode-mcp" {
		t.Errorf("name: want %q, got %q", "opencode-mcp", proc.Name)
	}
	if len(proc.Ports) != 1 || proc.Ports[0].Host != 3001 {
		t.Errorf("expected port 3001, got %v", proc.Ports)
	}
}

func TestProcessFeatureValidateMissingCommand(t *testing.T) {
	feat, err := newProcessFeature("bad", map[string]any{})
	if err != nil {
		t.Fatalf("create process feature: %v", err)
	}
	if errs := feat.Validate(); len(errs) == 0 {
		t.Errorf("expected validation errors for missing command")
	}
}

