package service

import (
	"context"

	"github.com/anomalyco/sandbox-manager/pkg/healthcheck"
)

// Definition describes a service type that can be run either as a local child
// process or inside a container. It is the minimal contract needed to add a
// new service to the supervisor.
//
// Implementations should be pure functions where possible: no I/O, no process
// management, no side effects. The generic ProcessService uses this definition
// to perform the actual work.
type Definition struct {
	// Type is the canonical service type name (e.g., "postgres", "redis").
	Type string

	// Parse converts the raw config (typically sandbox.ServiceConfig) into a typed
	// service-specific config.
	Parse func(raw any) (any, error)

	// Validate checks the typed config and returns all issues. It may be nil.
	Validate func(cfg any) []error

	// DataDir returns the directory where the service stores its data and logs.
	// It is used for both local and container runtimes.
	DataDir func(cfg any) string

	// LocalBinary returns the executable name to look up on PATH when running
	// as a local process. It may be empty for container-only services.
	LocalBinary func(cfg any) string

	// LocalInit runs one-time setup before the process is started (e.g., initdb).
	// It may be nil.
	LocalInit func(ctx context.Context, cfg any) error

	// LocalConfigFiles returns files that should be written before the process
	// starts. Keys are relative paths inside the service's data directory. It may
	// be nil.
	LocalConfigFiles func(cfg any) (map[string][]byte, error)

	// LocalArgs returns the command-line arguments for the local process. The
	// first element is not the binary; it is appended by the generic runner.
	LocalArgs func(cfg any) []string

	// LocalEnv returns environment variables for the local process. It may be nil.
	LocalEnv func(cfg any) map[string]string

	// PostStart runs after the process has passed its initial health check. It
	// is useful for one-time setup like creating users or databases. It may be nil.
	PostStart func(ctx context.Context, cfg any) error

	// HealthChecker returns a Checker for the service. It is used for both
	// local and container runtimes. The checker should honor any health_check
	// override present in the typed config.
	HealthChecker func(cfg any) (healthcheck.Checker, error)

	// ComposeHealthCheck returns the Docker Compose healthcheck definition for
	// the service. It may be nil.
	ComposeHealthCheck func(cfg any) *HealthCheck

	// ContainerImage returns the Docker image to use when running this service
	// in a container. It may be nil.
	ContainerImage func(cfg any) string

	// ContainerCommand returns the command to pass to the container. It may be nil.
	ContainerCommand func(cfg any) []string

	// ContainerEnv returns environment variables for the container. It may be nil.
	ContainerEnv func(cfg any) map[string]string

	// ContainerPorts returns port mappings for the container. It may be nil.
	ContainerPorts func(cfg any) []PortMapping

	// ContainerVolumes returns volume mappings for the container. It may be nil.
	ContainerVolumes func(cfg any) []VolumeMapping
}

// PortMapping describes a host-to-container port mapping.
type PortMapping struct {
	Host      int
	Container int
}

// VolumeMapping describes a host-to-container volume mapping.
type VolumeMapping struct {
	Host      string
	Container string
}

// HealthCheck describes a Docker Compose healthcheck.
type HealthCheck struct {
	Test        []string
	Interval    string
	Timeout     string
	Retries     int
	StartPeriod string
}
