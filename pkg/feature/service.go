package feature

import (
	"context"

	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

// ServiceFeature adapts a pkg/service.Definition into a Feature.
// It is the bridge between low-level service definitions and the higher-level
// sandbox Plan. The same Definition can be reused for local process, Docker,
// and Compose generation via the Plan.
type ServiceFeature struct {
	name string
	def  *serviceapi.Definition
	cfg  any
}

// NewServiceFeature creates a Feature from a service definition and typed config.
func NewServiceFeature(name string, def *serviceapi.Definition, cfg any) *ServiceFeature {
	return &ServiceFeature{name: name, def: def, cfg: cfg}
}

func (f *ServiceFeature) Name() string { return f.name }
func (f *ServiceFeature) Type() string { return f.def.Type }
func (f *ServiceFeature) Config() any  { return f.cfg }

// Validate checks the typed config using the underlying definition.
func (f *ServiceFeature) Validate() []error {
	if f.def.Validate == nil {
		return nil
	}
	return f.def.Validate(f.cfg)
}

// Contribute adds the service to the runtime plan.
func (f *ServiceFeature) Contribute(ctx context.Context, plan *Plan) error {
	svc := Service{
		Name:          f.name,
		Type:          f.def.Type,
		ContainerName: f.name,
		Networks:      []string{"sandbox"},
	}

	if f.def.ContainerImage != nil {
		svc.Image = f.def.ContainerImage(f.cfg)
	}

	if f.def.ContainerEnv != nil {
		svc.Environment = f.def.ContainerEnv(f.cfg)
	}

	if f.def.ContainerPorts != nil {
		for _, p := range f.def.ContainerPorts(f.cfg) {
			svc.Ports = append(svc.Ports, PortMapping{
				Host:      p.Host,
				Container: p.Container,
			})
		}
	}

	if f.def.ContainerVolumes != nil {
		for _, v := range f.def.ContainerVolumes(f.cfg) {
			svc.Volumes = append(svc.Volumes, VolumeMapping{
				Host:      v.Host,
				Container: v.Container,
			})
		}
	}

	if f.def.ComposeHealthCheck != nil {
		svc.HealthCheck = f.def.ComposeHealthCheck(f.cfg)
	}

	svc.Definition = f.def
	svc.TypedConfig = f.cfg

	plan.Runtime.Services = append(plan.Runtime.Services, svc)
	return nil
}

