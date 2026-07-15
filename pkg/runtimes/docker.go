package runtimes

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/anomalyco/sandbox-manager/pkg/process"
	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

// DockerRuntime runs services as Docker containers using the docker CLI.
type DockerRuntime struct {
	docker  string
	prefix  string
	network string
}

// DockerOption configures a DockerRuntime.
type DockerOption func(*DockerRuntime)

// WithPrefix sets the container name prefix.
func WithPrefix(prefix string) DockerOption {
	return func(r *DockerRuntime) { r.prefix = prefix }
}

// WithNetwork sets the docker network to attach containers to.
func WithNetwork(network string) DockerOption {
	return func(r *DockerRuntime) { r.network = network }
}

// NewDockerRuntime creates a Docker runtime. It returns an error if the docker
// binary is not available on PATH.
func NewDockerRuntime(opts ...DockerOption) (*DockerRuntime, error) {
	bin, err := exec.LookPath("docker")
	if err != nil {
		return nil, fmt.Errorf("docker binary not found on PATH: %w", err)
	}
	r := &DockerRuntime{docker: bin}
	for _, opt := range opts {
		opt(r)
	}
	return r, nil
}

func (r *DockerRuntime) Name() string { return "docker" }

func (r *DockerRuntime) Start(ctx context.Context, name string, def *serviceapi.Definition, cfg any) (Instance, error) {
	image := def.ContainerImage(cfg)
	if image == "" {
		return nil, fmt.Errorf("docker: no container image for %s", def.Type)
	}

	args := []string{
		"run",
		"--rm",
		"-d",
		"--name", r.containerName(name),
	}

	if r.network != "" {
		args = append(args, "--network", r.network)
	}

	if ports := def.ContainerPorts(cfg); len(ports) > 0 {
		for _, p := range ports {
			args = append(args, "-p", fmt.Sprintf("%d:%d", p.Host, p.Container))
		}
	}

	if vols := def.ContainerVolumes(cfg); len(vols) > 0 {
		for _, v := range vols {
			args = append(args, "-v", fmt.Sprintf("%s:%s", v.Host, v.Container))
		}
	}

	for k, v := range def.ContainerEnv(cfg) {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}

	args = append(args, image)

	if cmd := def.ContainerCommand(cfg); len(cmd) > 0 {
		args = append(args, cmd...)
	}

	execCmd := exec.CommandContext(ctx, r.docker, args...)
	out, err := execCmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker: start container: %w\n%s", err, out)
	}

	containerID := strings.TrimSpace(string(out))

	// Wait for at least one exposed port to be reachable.
	if ports := def.ContainerPorts(cfg); len(ports) > 0 {
		if err := process.WaitForPort(ctx, "127.0.0.1", ports[0].Host, process.DefaultPortPollTimeout); err != nil {
			_ = r.stopContainer(ctx, containerID)
			return nil, fmt.Errorf("docker: container not reachable: %w", err)
		}
	}

	return &dockerInstance{id: containerID, runtime: r}, nil
}

func (r *DockerRuntime) Stop(ctx context.Context, inst Instance) error {
	di, ok := inst.(*dockerInstance)
	if !ok {
		return nil
	}
	return r.stopContainer(ctx, di.id)
}

func (r *DockerRuntime) stopContainer(ctx context.Context, id string) error {
	cmd := exec.CommandContext(ctx, r.docker, "stop", "-t", "10", id)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker: stop container: %w\n%s", err, out)
	}
	return nil
}

func (r *DockerRuntime) containerName(name string) string {
	if r.prefix != "" {
		return r.prefix + "-" + name
	}
	return name
}

// dockerInstance tracks a running Docker container.
type dockerInstance struct {
	id      string
	runtime *DockerRuntime
}

func (i *dockerInstance) Running() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, i.runtime.docker, "ps", "-q", "--no-trunc", "-f", "id="+i.id)
	out, err := cmd.Output()
	return err == nil && len(out) > 0
}

func (i *dockerInstance) ID() string { return i.id }

var _ Runtime = (*DockerRuntime)(nil)
