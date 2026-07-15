package runtimes

import (
	"context"
	"fmt"

	"github.com/anomalyco/sandbox-manager/pkg/healthcheck"
	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

// RuntimeService adapts a Runtime + Definition + config into a service.Interface.
// It is the standard wrapper used by the CLI to create service instances.
type RuntimeService struct {
	name    string
	def     *serviceapi.Definition
	cfg     any
	runtime Runtime
	inst    Instance
	checker healthcheck.Checker
}

// NewRuntimeService creates a service.Interface backed by the given runtime.
func NewRuntimeService(name string, def *serviceapi.Definition, cfg any, runtime Runtime) *RuntimeService {
	return &RuntimeService{
		name:    name,
		def:     def,
		cfg:     cfg,
		runtime: runtime,
	}
}

func (s *RuntimeService) Type() string  { return s.def.Type }
func (s *RuntimeService) Name() string  { return s.name }
func (s *RuntimeService) Running() bool { return s.inst != nil && s.inst.Running() }

func (s *RuntimeService) Start(ctx context.Context) error {
	inst, err := s.runtime.Start(ctx, s.name, s.def, s.cfg)
	if err != nil {
		return err
	}
	s.inst = inst
	return nil
}

func (s *RuntimeService) Stop(ctx context.Context) error {
	if s.inst == nil {
		return nil
	}
	return s.runtime.Stop(ctx, s.inst)
}

func (s *RuntimeService) Health(ctx context.Context) error {
	checker, err := s.healthChecker()
	if err != nil {
		return err
	}
	return checker.Check(ctx)
}

func (s *RuntimeService) healthChecker() (healthcheck.Checker, error) {
	if s.checker != nil {
		return s.checker, nil
	}
	if s.def.HealthChecker == nil {
		return nil, fmt.Errorf("%s: no health checker configured", s.def.Type)
	}
	checker, err := s.def.HealthChecker(s.cfg)
	if err != nil {
		return nil, err
	}
	s.checker = checker
	return checker, nil
}

// RuntimeName returns the runtime backing this service.
func (s *RuntimeService) RuntimeName() string {
	return s.runtime.Name()
}

// Ensure RuntimeService implements service.Interface.
var _ serviceapi.Interface = (*RuntimeService)(nil)
