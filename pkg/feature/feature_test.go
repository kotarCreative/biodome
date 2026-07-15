package feature

import (
	"context"
	"errors"
	"testing"

	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

func TestRegistryRegisterAndCreate(t *testing.T) {
	r := NewRegistry()

	called := false
	r.Register("test", func(name string, raw any) (Feature, error) {
		called = true
		return &testFeature{name: name}, nil
	})

	feat, err := r.Create("test", "my-test", nil)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if !called {
		t.Fatal("constructor was not called")
	}
	if feat.Name() != "my-test" {
		t.Errorf("expected name 'my-test', got %q", feat.Name())
	}
	if feat.Type() != "test" {
		t.Errorf("expected type 'test', got %q", feat.Type())
	}
}

func TestRegistryUnknownType(t *testing.T) {
	r := NewRegistry()
	_, err := r.Create("unknown", "x", nil)
	if err == nil {
		t.Fatal("expected error for unknown type")
	}
}

func TestRegistryTypes(t *testing.T) {
	r := NewRegistry()
	r.Register("b", func(name string, raw any) (Feature, error) { return nil, nil })
	r.Register("a", func(name string, raw any) (Feature, error) { return nil, nil })

	types := r.Types()
	if len(types) != 2 {
		t.Fatalf("expected 2 types, got %d", len(types))
	}
	if types[0] != "a" || types[1] != "b" {
		t.Errorf("expected sorted types [a b], got %v", types)
	}
}

func TestPlanContribution(t *testing.T) {
	plan := &Plan{
		Runtime: RuntimePlan{
			Environment: make(map[string]string),
		},
	}

	feat := &testFeature{name: "test"}
	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	if plan.Runtime.Environment["TEST"] != "1" {
		t.Errorf("expected env var TEST=1, got %v", plan.Runtime.Environment)
	}
}

type testFeature struct {
	name string
}

func (f *testFeature) Name() string        { return f.name }
func (f *testFeature) Type() string        { return "test" }
func (f *testFeature) Config() any         { return nil }
func (f *testFeature) Validate() []error   { return nil }
func (f *testFeature) Contribute(_ context.Context, plan *Plan) error {
	if plan.Runtime.Environment == nil {
		plan.Runtime.Environment = make(map[string]string)
	}
	plan.Runtime.Environment["TEST"] = "1"
	return nil
}

func TestServiceFeatureContribution(t *testing.T) {
	def := &serviceapi.Definition{
		Type: "mock-service",
		ContainerImage: func(cfg any) string {
			return cfg.(string)
		},
		ContainerEnv: func(cfg any) map[string]string {
			return map[string]string{"KEY": "value"}
		},
		ContainerPorts: func(cfg any) []serviceapi.PortMapping {
			return []serviceapi.PortMapping{{Host: 1234, Container: 5678}}
		},
		ContainerVolumes: func(cfg any) []serviceapi.VolumeMapping {
			return []serviceapi.VolumeMapping{{Host: "data", Container: "/data"}}
		},
		ComposeHealthCheck: func(cfg any) *serviceapi.HealthCheck {
			return &serviceapi.HealthCheck{Test: []string{"CMD", "echo"}, Interval: "5s"}
		},
	}

	feat := NewServiceFeature("my-svc", def, "mock:latest")
	plan := &Plan{
		Runtime: RuntimePlan{
			Environment: make(map[string]string),
		},
	}

	if err := feat.Contribute(context.Background(), plan); err != nil {
		t.Fatalf("Contribute failed: %v", err)
	}

	if len(plan.Runtime.Services) != 1 {
		t.Fatalf("expected 1 service, got %d", len(plan.Runtime.Services))
	}
	svc := plan.Runtime.Services[0]
	if svc.Name != "my-svc" {
		t.Errorf("expected name 'my-svc', got %q", svc.Name)
	}
	if svc.Type != "mock-service" {
		t.Errorf("expected type 'mock-service', got %q", svc.Type)
	}
	if svc.Image != "mock:latest" {
		t.Errorf("expected image 'mock:latest', got %q", svc.Image)
	}
	if svc.Environment["KEY"] != "value" {
		t.Errorf("expected env KEY=value, got %v", svc.Environment)
	}
	if len(svc.Ports) != 1 || svc.Ports[0].Host != 1234 {
		t.Errorf("unexpected ports: %v", svc.Ports)
	}
	if len(svc.Volumes) != 1 || svc.Volumes[0].Host != "data" {
		t.Errorf("unexpected volumes: %v", svc.Volumes)
	}
	if svc.HealthCheck == nil || svc.HealthCheck.Interval != "5s" {
		t.Errorf("unexpected healthcheck: %v", svc.HealthCheck)
	}
}

func TestServiceFeatureValidation(t *testing.T) {
	def := &serviceapi.Definition{
		Type: "mock",
		Validate: func(cfg any) []error {
			return []error{errors.New("bad config")}
		},
	}
	feat := NewServiceFeature("x", def, nil)
	errs := feat.Validate()
	if len(errs) != 1 {
		t.Fatalf("expected 1 error, got %d", len(errs))
	}
}
