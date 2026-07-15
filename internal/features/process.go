package features

import (
	"context"
	"fmt"

	"github.com/anomalyco/sandbox-manager/pkg/feature"
	"gopkg.in/yaml.v3"
)

// ProcessConfig is the parsed configuration for a process feature.
type ProcessConfig struct {
	Name        string                       `yaml:"name"`
	Command     interface{}                  `yaml:"command"`
	Port        int                          `yaml:"port"`
	Ports       map[string]int               `yaml:"ports"`
	Environment map[string]string            `yaml:"env"`
	WorkingDir  string                       `yaml:"working_dir"`
	HealthCheck *ProcessHealthCheckConfig    `yaml:"healthcheck"`
}

// ProcessHealthCheckConfig is the parsed configuration for a process health check.
type ProcessHealthCheckConfig struct {
	Type        string      `yaml:"type"`
	URL         string      `yaml:"url"`
	Command     interface{} `yaml:"command"`
	Port        int         `yaml:"port"`
	Interval    string      `yaml:"interval"`
	Timeout     string      `yaml:"timeout"`
	Retries     int         `yaml:"retries"`
	StartPeriod string      `yaml:"start_period"`
}

// ProcessFeature contributes a long-running process to the dev container.
type ProcessFeature struct {
	name string
	cfg  ProcessConfig
}

func newProcessFeature(name string, raw any) (feature.Feature, error) {
	data, err := yaml.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("process: marshal config: %w", err)
	}

	var cfg ProcessConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("process: unmarshal config: %w", err)
	}
	cfg.Name = name
	return &ProcessFeature{name: name, cfg: cfg}, nil
}

func (f *ProcessFeature) Name() string { return f.name }
func (f *ProcessFeature) Type() string { return "process" }
func (f *ProcessFeature) Config() any  { return f.cfg }

func (f *ProcessFeature) Validate() []error {
	var errs []error
	cmd, err := f.command()
	if err != nil {
		errs = append(errs, err)
	}
	if len(cmd) == 0 {
		errs = append(errs, fmt.Errorf("process %q: command is required", f.name))
	}
	if len(f.cfg.Ports) == 0 && f.cfg.Port == 0 && f.cfg.HealthCheck != nil && f.cfg.HealthCheck.Type == "http" && f.cfg.HealthCheck.URL == "" {
		errs = append(errs, fmt.Errorf("process %q: healthcheck url required when no port is declared", f.name))
	}
	return errs
}

func (f *ProcessFeature) Contribute(ctx context.Context, plan *feature.Plan) error {
	cmd, err := f.command()
	if err != nil {
		return err
	}

	proc := feature.Process{
		Name:        f.name,
		Command:     cmd,
		Environment: f.cfg.Environment,
		WorkingDir:  f.cfg.WorkingDir,
	}

	if f.cfg.Port > 0 {
		proc.Ports = append(proc.Ports, feature.Port{Host: f.cfg.Port, Container: f.cfg.Port})
	}
	for _, port := range f.cfg.Ports {
		proc.Ports = append(proc.Ports, feature.Port{Host: port, Container: port})
	}

	if f.cfg.HealthCheck != nil {
		proc.HealthCheck = f.healthCheck(f.cfg.HealthCheck)
	}

	plan.Runtime.Processes = append(plan.Runtime.Processes, proc)

	// Merge process env vars into the runtime environment.
	for k, v := range f.cfg.Environment {
		plan.Runtime.Environment[k] = v
	}

	// Ensure curl is available for HTTP healthchecks.
	if proc.HealthCheck != nil && proc.HealthCheck.Type == "http" {
		addAptPackage(plan, "curl")
	}

	_ = ctx
	return nil
}

func (f *ProcessFeature) command() ([]string, error) {
	switch v := f.cfg.Command.(type) {
	case nil:
		return nil, fmt.Errorf("process %q: command is required", f.name)
	case string:
		if v == "" {
			return nil, fmt.Errorf("process %q: command is required", f.name)
		}
		return []string{"sh", "-c", v}, nil
	case []interface{}:
		cmd := make([]string, 0, len(v))
		for _, arg := range v {
			s, ok := arg.(string)
			if !ok {
				return nil, fmt.Errorf("process %q: command arguments must be strings", f.name)
			}
			cmd = append(cmd, s)
		}
		return cmd, nil
	case []string:
		return v, nil
	default:
		return nil, fmt.Errorf("process %q: command must be a string or a list of strings", f.name)
	}
}

func (f *ProcessFeature) healthCheck(cfg *ProcessHealthCheckConfig) *feature.ProcessHealthCheck {
	hc := &feature.ProcessHealthCheck{
		Type:        cfg.Type,
		URL:         cfg.URL,
		Port:        cfg.Port,
		Interval:    cfg.Interval,
		Timeout:     cfg.Timeout,
		Retries:     cfg.Retries,
		StartPeriod: cfg.StartPeriod,
	}
	if cmd, err := commandFromYAML(cfg.Command); err == nil && len(cmd) > 0 {
		hc.Command = cmd
	}
	if hc.Type == "" {
		hc.Type = "http"
	}
	if hc.Type == "http" && hc.URL == "" && hc.Port > 0 {
		hc.URL = fmt.Sprintf("http://localhost:%d", hc.Port)
	}
	if hc.Type == "http" && hc.URL == "" && f.cfg.Port > 0 {
		hc.URL = fmt.Sprintf("http://localhost:%d", f.cfg.Port)
	}
	return hc
}

func commandFromYAML(cmd interface{}) ([]string, error) {
	switch v := cmd.(type) {
	case nil:
		return nil, nil
	case string:
		return []string{"sh", "-c", v}, nil
	case []interface{}:
		var out []string
		for _, arg := range v {
			s, ok := arg.(string)
			if !ok {
				return nil, fmt.Errorf("command arguments must be strings")
			}
			out = append(out, s)
		}
		return out, nil
	case []string:
		return v, nil
	default:
		return nil, fmt.Errorf("command must be a string or a list of strings")
	}
}
