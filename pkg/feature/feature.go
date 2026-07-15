// Package feature defines the primitive abstraction for sandbox capabilities.
// A Feature is anything the user can declare in the sandbox/ config that
// contributes to the final sandbox: languages, services, tools, agents,
// preview URLs, etc.
//
// Features write into a shared Plan (intermediate representation), and the
// CLI generators read from that Plan to produce Dockerfile, docker-compose,
// AGENTS.md, and other artifacts.
package feature

import (
	"context"
	"fmt"
	"sort"

	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

// Feature is a unit of capability declared in the sandbox config.
// Every feature has a name, a type, a parsed config, and the ability to
// contribute to the shared Plan.
type Feature interface {
	// Name is the declared instance name (e.g. "postgres", "app-db").
	Name() string

	// Type is the feature kind (e.g. "service", "language", "agent").
	Type() string

	// Config returns the parsed, typed config for this feature instance.
	Config() any

	// Validate checks the parsed config and returns all issues.
	Validate() []error

	// Contribute adds this feature's contributions to the shared Plan.
	Contribute(ctx context.Context, plan *Plan) error
}

// Plan is the intermediate representation of everything that goes into a sandbox.
// It is built by invoking Contribute on every discovered feature.
type Plan struct {
	// Project is the canonical project name.
	Project string

	// Build describes how to build the dev container image.
	Build BuildPlan

	// Runtime describes what runs when the sandbox is up.
	Runtime RuntimePlan

	// Agents describes integrations with AI coding agents.
	Agents AgentPlan
}

// BuildPlan describes the dev container image.
type BuildPlan struct {
	// BaseImage is the FROM image for the base stage.
	BaseImage string

	// AptPackages are system packages to install.
	AptPackages []string

	// LanguageSnippets are Dockerfile RUN/ENV lines for language setup.
	LanguageSnippets []string

	// DependencyFiles are manifest files copied before dependency install.
	DependencyFiles []string

	// DependencyInstalls are Dockerfile RUN commands for installing deps.
	// The generator picks the first command whose Files all exist.
	DependencyInstalls []DependencyInstall

	// CopyArtifacts are COPY --from=deps lines for the final stage.
	// The generator writes the Lines when all Files exist.
	CopyArtifacts []CopyArtifact

	// Environment is the set of env vars baked into the image.
	Environment map[string]string

	// NodeModulesVolume is true when a node_modules named volume should be used.
	NodeModulesVolume bool
}

// DependencyInstall describes a dependency install command and the files that
// must exist for it to run.
type DependencyInstall struct {
	Files   []string
	Command string
}

// CopyArtifact describes artifact copy lines and the files that must exist for
// them to be emitted.
type CopyArtifact struct {
	Files []string
	Lines []string
}

// RuntimePlan describes the running sandbox.
type RuntimePlan struct {
	// Services are the backing services that run alongside the dev container.
	Services []Service

	// Networks are the Docker networks to create.
	Networks []Network

	// Volumes are the named volumes to create.
	Volumes []Volume

	// Ports are host ports that should be exposed by the dev container.
	Ports []Port

	// Environment is the set of env vars injected into the dev container.
	Environment map[string]string

	// Processes are long-running processes managed inside the dev container.
	Processes []Process

	// Hooks are lifecycle hooks.
	Hooks Hooks
}

// Service describes a backing service in the runtime plan.
type Service struct {
	Name          string
	Type          string
	Image         string
	ContainerName string
	Environment   map[string]string
	Ports         []PortMapping
	Volumes       []VolumeMapping
	HealthCheck   *serviceapi.HealthCheck
	Networks      []string

	// Definition is the underlying service definition. It is stored so the
	// runner can instantiate a runtime service from the Plan.
	Definition *serviceapi.Definition

	// TypedConfig is the parsed, type-specific config for the service.
	TypedConfig any
}

// PortMapping is a host-to-container port mapping.
type PortMapping struct {
	Host      int
	Container int
}

// VolumeMapping is a host-to-container volume mapping.
type VolumeMapping struct {
	Host      string
	Container string
}

// Network describes a Docker network.
type Network struct {
	Name   string
	Driver string
}

// Volume describes a named volume.
type Volume struct {
	Name string
}

// Port describes a host port exposed by the dev container.
type Port struct {
	Host      int
	Container int
}

// Process describes a long-running process managed inside the dev container.
// Processes are used for dev servers (e.g. Django runserver) and custom
// servers such as MCP servers.
type Process struct {
	Name        string
	Command     []string
	Ports       []Port
	Environment map[string]string
	HealthCheck *ProcessHealthCheck
	WorkingDir  string
}

// ProcessHealthCheck describes a health check for a process.
type ProcessHealthCheck struct {
	Type     string
	URL      string
	Command  []string
	Port     int
	Interval string
	Timeout  string
	Retries  int
	StartPeriod string
}

// Hooks describes lifecycle hooks.
type Hooks struct {
	BuildPre  []HookAction
	BuildPost []HookAction
	StartPost []HookAction
	StopPre   []HookAction
	ExecPre   []HookAction
	ExecPost  []HookAction
}

// HookAction is a single lifecycle hook action.
type HookAction struct {
	Command string
	Inline  string
}

// AgentPlan describes integrations with AI coding agents.
type AgentPlan struct {
	ContextFiles []ContextFile
	MCPs         []MCPConfig
	PiExtensions []PiExtension
	Commands     []AgentCommand
}

// ContextFile is a generated context file for an agent.
type ContextFile struct {
	Path    string
	Section string
	Content string
}

// MCPConfig describes an MCP server.
type MCPConfig struct {
	Name    string
	Command []string
}

// PiExtension describes a Pi extension package.
type PiExtension struct {
	Name string
}

// AgentCommand describes an agent command.
type AgentCommand struct {
	Name        string
	Description string
	Command     []string
}

// Registry maps feature type names to constructors.
type Registry struct {
	constructors map[string]Constructor
}

// Constructor creates a Feature instance from a parsed raw config.
type Constructor func(name string, raw any) (Feature, error)

// NewRegistry creates an empty feature registry.
func NewRegistry() *Registry {
	return &Registry{constructors: make(map[string]Constructor)}
}

// Register adds a feature constructor to the registry.
func (r *Registry) Register(typeName string, ctor Constructor) {
	r.constructors[typeName] = ctor
}

// Create instantiates a feature of the given type.
func (r *Registry) Create(typeName string, name string, raw any) (Feature, error) {
	ctor, ok := r.constructors[typeName]
	if !ok {
		return nil, fmt.Errorf("unknown feature type %q", typeName)
	}
	return ctor(name, raw)
}

// Types returns the registered feature type names in sorted order.
func (r *Registry) Types() []string {
	result := make([]string, 0, len(r.constructors))
	for t := range r.constructors {
		result = append(result, t)
	}
	sort.Strings(result)
	return result
}

// Has reports whether the registry has a constructor for the given type.
func (r *Registry) Has(typeName string) bool {
	_, ok := r.constructors[typeName]
	return ok
}
