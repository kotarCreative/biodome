package runtimes

import (
	"context"

	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

// LocalRuntime runs services as child processes on the host.
type LocalRuntime struct{}

// NewLocalRuntime creates a local process runtime.
func NewLocalRuntime() *LocalRuntime {
	return &LocalRuntime{}
}

func (r *LocalRuntime) Name() string { return "local" }

func (r *LocalRuntime) Start(ctx context.Context, name string, def *serviceapi.Definition, cfg any) (Instance, error) {
	svc := NewProcessService(name, def, cfg)
	if err := svc.Start(ctx); err != nil {
		return nil, err
	}
	return &localInstance{svc: svc}, nil
}

func (r *LocalRuntime) Stop(ctx context.Context, inst Instance) error {
	li, ok := inst.(*localInstance)
	if !ok {
		return nil
	}
	return li.svc.Stop(ctx)
}

type localInstance struct {
	svc *ProcessService
}

func (i *localInstance) Running() bool { return i.svc.Running() }
func (i *localInstance) ID() string    { return i.svc.Name() }

var _ Runtime = (*LocalRuntime)(nil)
