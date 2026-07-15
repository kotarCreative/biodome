package docker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/anomalyco/sandbox-manager/internal/supervisor"
	"github.com/anomalyco/sandbox-manager/pkg/feature"
	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
	"github.com/anomalyco/sandbox-manager/pkg/runtimes"
)

const devContainerName = "dev"

// Runner orchestrates the dev container and backing services.
type Runner struct {
	project string
	prefix  string
	network string
}

// NewRunner creates a runner for the given project.
func NewRunner(project string) *Runner {
	return &Runner{
		project: project,
		prefix:  project,
		network: project + "-net",
	}
}

// Build builds the dev Docker image.
func (r *Runner) Build(ctx context.Context, rootDir string) error {
	dir := SandboxDir(rootDir)
	if _, err := os.Stat(filepath.Join(dir, "Dockerfile")); err != nil {
		return fmt.Errorf("no Dockerfile found at %s (run 'sandbox build' first)", dir)
	}

	tag := r.prefix + "-dev:latest"
	cmd := exec.CommandContext(ctx, "docker", "build", "-t", tag, "-f", filepath.Join(dir, "Dockerfile"), rootDir)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker build failed: %w", err)
	}
	return nil
}

// StartServices starts backing services using the services-runner supervisor.
// The services are read from the runtime Plan.
func (r *Runner) StartServices(ctx context.Context, plan *feature.Plan) (*supervisor.Supervisor, error) {
	if len(plan.Runtime.Services) == 0 {
		return nil, nil
	}

	// Create docker network.
	if err := r.ensureNetwork(ctx); err != nil {
		return nil, err
	}

	// Create services.
	rt, err := runtimes.NewDockerRuntime(
		runtimes.WithPrefix(r.prefix),
		runtimes.WithNetwork(r.network),
	)
	if err != nil {
		return nil, err
	}

	var svcs []serviceapi.Interface
	deps := make(map[string][]string)

	for _, svc := range plan.Runtime.Services {
		if svc.Definition == nil {
			return nil, fmt.Errorf("%s: no service definition in plan", svc.Name)
		}
		runtimeSvc := runtimes.NewRuntimeService(svc.Name, svc.Definition, svc.TypedConfig, rt)
		svcs = append(svcs, runtimeSvc)
	}

	logsDir := filepath.Join(".", ".sandbox", "logs")
	sup, err := supervisor.New(svcs, deps, logsDir)
	if err != nil {
		return nil, err
	}

	allReady := sup.Start(ctx)
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := sup.WaitForReady(waitCtx, allReady); err != nil {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		sup.Stop(stopCtx)
		return nil, fmt.Errorf("services failed to start: %w", err)
	}

	go sup.Supervise(ctx)
	return sup, nil
}

// StartDev starts the dev container.
// When the Plan declares managed processes, the container uses the image's
// default CMD (supervisord) and exposes the process ports. Otherwise it falls
// back to a long-running sleep container.
func (r *Runner) StartDev(ctx context.Context, rootDir string, plan *feature.Plan) error {
	if err := r.ensureNetwork(ctx); err != nil {
		return err
	}

	name := r.containerName(devContainerName)
	image := r.prefix + "-dev:latest"

	// Check if already running.
	cmd := exec.CommandContext(ctx, "docker", "ps", "-q", "-f", "name="+name)
	out, _ := cmd.Output()
	if len(out) > 0 {
		return fmt.Errorf("dev container %q is already running", name)
	}

	args := []string{
		"run", "-d", "--rm",
		"--name", name,
		"--network", r.network,
		"-v", rootDir + ":/workspace",
		"-w", "/workspace",
	}

	for k, v := range plan.Runtime.Environment {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}

	for _, proc := range plan.Runtime.Processes {
		for _, p := range proc.Ports {
			args = append(args, "-p", fmt.Sprintf("%d:%d", p.Host, p.Container))
		}
	}

	args = append(args, image)

	// If no managed processes are declared, keep the container alive with sleep.
	if len(plan.Runtime.Processes) == 0 {
		args = append(args, "sleep", "infinity")
	}

	cmd = exec.CommandContext(ctx, "docker", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker run failed: %w", err)
	}
	return nil
}

// StopDev stops the dev container.
func (r *Runner) StopDev(ctx context.Context) error {
	name := r.containerName(devContainerName)
	cmd := exec.CommandContext(ctx, "docker", "stop", "-t", "10", name)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker stop failed: %w", err)
	}
	return nil
}

// Exec runs a command inside the dev container.
func (r *Runner) Exec(ctx context.Context, command []string) error {
	name := r.containerName(devContainerName)
	cmd := exec.CommandContext(ctx, "docker", append([]string{"exec", name}, command...)...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// ensureNetwork creates the docker network if it doesn't exist.
func (r *Runner) ensureNetwork(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "docker", "network", "ls", "-q", "-f", "name="+r.network)
	out, err := cmd.Output()
	if err == nil && len(out) > 0 {
		return nil
	}
	cmd = exec.CommandContext(ctx, "docker", "network", "create", r.network)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// PrefixedName returns a container name prefixed with the project name.
func (r *Runner) PrefixedName(name string) string {
	return r.prefix + "-" + name
}

// StopContainer stops a specific container by name.
func (r *Runner) StopContainer(ctx context.Context, name string) error {
	cmd := exec.CommandContext(ctx, "docker", "stop", "-t", "10", name)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func (r *Runner) containerName(name string) string {
	return r.prefix + "-" + name
}
