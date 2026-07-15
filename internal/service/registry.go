package service

import (
	"fmt"
	"strings"

	"github.com/anomalyco/sandbox-manager/internal/sandbox"
	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
	"github.com/anomalyco/sandbox-manager/pkg/runtimes"
)

// Definition is an alias for the public service definition.
type Definition = serviceapi.Definition

var definitions = map[string]*Definition{}

// RegisterDefinition registers a service type described by a Definition.
func RegisterDefinition(d *Definition) {
	definitions[d.Type] = d
}

// Types returns the list of registered service type names.
func Types() []string {
	result := make([]string, 0, len(definitions))
	for t := range definitions {
		result = append(result, t)
	}
	return result
}

// DetectType determines the service type from the service name and config.
func DetectType(name string, cfg sandbox.ServiceConfig) string {
	// Explicit type override takes precedence.
	if cfg.Type != "" {
		return cfg.Type
	}

	// Check image hint next.
	if cfg.Image != "" {
		lower := strings.ToLower(cfg.Image)
		if strings.Contains(lower, "postgres") || strings.Contains(lower, "postgis") {
			return "postgres"
		}
		if strings.Contains(lower, "redis") {
			return "redis"
		}
	}
	lower := strings.ToLower(name)
	if strings.Contains(lower, "postgres") || strings.Contains(lower, "pg") {
		return "postgres"
	}
	if strings.Contains(lower, "redis") {
		return "redis"
	}
	return ""
}

// DefinitionFor returns the registered definition for the given service type.
func DefinitionFor(serviceType string) (*Definition, bool) {
	def, ok := definitions[serviceType]
	return def, ok
}

// Create instantiates a service using the registered definition.
func Create(name string, cfg sandbox.ServiceConfig, runtimeName string) (serviceapi.Interface, error) {
	svcType := DetectType(name, cfg)
	if svcType == "" {
		return nil, fmt.Errorf("cannot detect service type for %q (image: %q)", name, cfg.Image)
	}

	def, ok := definitions[svcType]
	if !ok {
		return nil, fmt.Errorf("unknown service type %q (known: %v)", svcType, Types())
	}

	typedCfg, err := def.Parse(cfg)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}

	rt, err := runtimeFor(runtimeName)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}

	return runtimes.NewRuntimeService(name, def, typedCfg, rt), nil
}

func runtimeFor(name string) (runtimes.Runtime, error) {
	switch name {
	case "local":
		return runtimes.NewLocalRuntime(), nil
	case "docker":
		return runtimes.NewDockerRuntime()
	default:
		return nil, fmt.Errorf("unknown runtime %q", name)
	}
}

// Ensure RuntimeService implements service.Interface.
var _ serviceapi.Interface = (*runtimes.RuntimeService)(nil)
