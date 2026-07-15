// Package features registers the built-in sandbox features and exposes a
// registry that the builder uses to instantiate features from config.
//
// Custom features can be added by registering a constructor in the same
// registry before building the sandbox Plan.
package features

import (
	"fmt"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	"github.com/anomalyco/sandbox-manager/internal/service"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
	"gopkg.in/yaml.v3"
)

// NewRegistry returns a registry populated with all built-in features.
func NewRegistry() *feature.Registry {
	r := feature.NewRegistry()
	registerLanguages(r)
	registerPackages(r)
	registerTools(r)
	registerServices(r)
	registerProcesses(r)
	return r
}

func registerLanguages(r *feature.Registry) {
	r.Register("node", newNodeFeature)
	r.Register("python", newPythonFeature)
	r.Register("go", newGoFeature)
	r.Register("rust", newRustFeature)
	r.Register("java", newJavaFeature)
}

func registerPackages(r *feature.Registry) {
	r.Register("apt-packages", newAptPackagesFeature)
	r.Register("npm-packages", newNpmPackagesFeature)
	r.Register("pip-packages", newPipPackagesFeature)
	r.Register("nix-packages", newNixPackagesFeature)
	r.Register("cargo-packages", newCargoPackagesFeature)
	r.Register("go-packages", newGoPackagesFeature)
	r.Register("gem-packages", newGemPackagesFeature)
}

// registerServices adds a constructor for every registered service definition.
// This makes all services (postgres, redis, and any custom services registered
// via service.RegisterDefinition) available as features.
func registerServices(r *feature.Registry) {
	for _, svcType := range service.Types() {
		def, ok := service.DefinitionFor(svcType)
		if !ok {
			continue
		}
		r.Register(svcType, serviceConstructor(svcType, def))
	}
}

func serviceConstructor(svcType string, def *service.Definition) feature.Constructor {
	return func(name string, raw any) (feature.Feature, error) {
		cfg, err := toServiceConfig(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", svcType, err)
		}
		typed, err := def.Parse(cfg)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", svcType, err)
		}
		return feature.NewServiceFeature(name, def, typed), nil
	}
}

func registerProcesses(r *feature.Registry) {
	r.Register("process", newProcessFeature)
}

// toServiceConfig normalizes raw config into a sandbox.ServiceConfig.
// It accepts both ServiceConfig (from services.yaml) and map[string]any (from
// custom feature files).
func toServiceConfig(raw any) (sandbox.ServiceConfig, error) {
	if cfg, ok := raw.(sandbox.ServiceConfig); ok {
		return cfg, nil
	}

	m, ok := raw.(map[string]any)
	if !ok {
		return sandbox.ServiceConfig{}, fmt.Errorf("expected sandbox.ServiceConfig or map[string]any, got %T", raw)
	}

	data, err := yaml.Marshal(m)
	if err != nil {
		return sandbox.ServiceConfig{}, fmt.Errorf("marshal config: %w", err)
	}

	var cfg sandbox.ServiceConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return sandbox.ServiceConfig{}, fmt.Errorf("unmarshal config: %w", err)
	}
	return cfg, nil
}
