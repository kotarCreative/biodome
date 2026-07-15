package features

import (
	"testing"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
)

func TestNewRegistryHasServices(t *testing.T) {
	r := NewRegistry()

	for _, svcType := range []string{"postgres", "redis"} {
		if !r.Has(svcType) {
			t.Errorf("expected registry to have %q", svcType)
		}
	}
}

func TestNewRegistryCreatePostgres(t *testing.T) {
	r := NewRegistry()

	feat, err := r.Create("postgres", "db", sandbox.ServiceConfig{Port: 5432})
	if err != nil {
		t.Fatalf("Create postgres failed: %v", err)
	}
	if feat.Name() != "db" {
		t.Errorf("expected name 'db', got %q", feat.Name())
	}
	if feat.Type() != "postgres" {
		t.Errorf("expected type 'postgres', got %q", feat.Type())
	}

	sf, ok := feat.(*feature.ServiceFeature)
	if !ok {
		t.Fatalf("expected *feature.ServiceFeature, got %T", feat)
	}
	if sf.Config() == nil {
		t.Error("expected parsed config")
	}
}

func TestNewRegistryCustomFeature(t *testing.T) {
	r := NewRegistry()

	called := false
	r.Register("custom", func(name string, raw any) (feature.Feature, error) {
		called = true
		return &feature.ServiceFeature{}, nil
	})

	_, err := r.Create("custom", "x", nil)
	if err != nil {
		t.Fatalf("Create custom failed: %v", err)
	}
	if !called {
		t.Fatal("custom constructor was not called")
	}
}
