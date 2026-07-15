// Package runtimes provides execution backends for services.
// A Runtime abstracts how a service is started, stopped, and health-checked so
// that the same service definition can run either as a local child process or
// inside a container.
package runtimes

import (
	"context"

	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

// Runtime is the execution backend for a service.
type Runtime interface {
	// Name returns the runtime identifier (e.g., "local", "docker").
	Name() string

	// Start launches the service and returns an instance handle.
	Start(ctx context.Context, name string, def *serviceapi.Definition, cfg any) (Instance, error)

	// Stop terminates the given instance.
	Stop(ctx context.Context, inst Instance) error
}

// Instance is a handle to a running service produced by a Runtime.
type Instance interface {
	// Running reports whether the instance is still believed to be running.
	Running() bool
	// ID returns a short identifier for the instance (e.g., container ID or PID).
	ID() string
}

// Default is the default runtime name.
const Default = "docker"
