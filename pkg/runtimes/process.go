package runtimes

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/anomalyco/sandbox-manager/pkg/healthcheck"
	"github.com/anomalyco/sandbox-manager/pkg/process"
	serviceapi "github.com/anomalyco/sandbox-manager/pkg/service"
)

// ProcessService is a generic service implementation driven by a Definition.
// It handles the common lifecycle (init, config files, start, health, stop) so
// that each service type only needs to describe its unique behavior.
type ProcessService struct {
	name    string
	def     *serviceapi.Definition
	cfg     any
	process *process.Process

	checker healthcheck.Checker
}

// NewProcessService creates a generic service instance from a definition and a
// typed config.
func NewProcessService(name string, def *serviceapi.Definition, cfg any) *ProcessService {
	return &ProcessService{
		name:    name,
		def:     def,
		cfg:     cfg,
		process: process.New(name),
	}
}

func (s *ProcessService) Type() string  { return s.def.Type }
func (s *ProcessService) Name() string  { return s.name }
func (s *ProcessService) Running() bool { return s.process.IsRunning() }

func (s *ProcessService) Start(ctx context.Context) error {
	if err := s.validate(); err != nil {
		return err
	}

	if err := s.localInit(ctx); err != nil {
		return err
	}

	if err := s.writeConfigFiles(); err != nil {
		return err
	}

	bin, args, env, err := s.localCommand()
	if err != nil {
		return err
	}

	logDir, err := s.logDir()
	if err != nil {
		return err
	}
	logF, err := process.OpenLogFile(logDir, s.def.Type+".log")
	if err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), env...)
	if err := s.process.Start(ctx, cmd, logF); err != nil {
		return fmt.Errorf("%s: start failed: %w", s.def.Type, err)
	}

	checker, err := s.healthChecker()
	if err != nil {
		_ = s.process.Stop(process.DefaultStopTimeout)
		return err
	}
	// Poll health check for up to 10 seconds to allow for slow startup.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if err := checker.Check(ctx); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = s.process.Stop(process.DefaultStopTimeout)
			return fmt.Errorf("%s: not ready after start: %w", s.def.Type, err)
		}
		select {
		case <-ctx.Done():
			_ = s.process.Stop(process.DefaultStopTimeout)
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}

	if s.def.PostStart != nil {
		if err := s.def.PostStart(ctx, s.cfg); err != nil {
			_ = s.process.Stop(process.DefaultStopTimeout)
			return fmt.Errorf("%s: post-start failed: %w", s.def.Type, err)
		}
	}

	return nil
}

func (s *ProcessService) Stop(ctx context.Context) error {
	return s.process.Stop(process.DefaultStopTimeout)
}

func (s *ProcessService) Health(ctx context.Context) error {
	checker, err := s.healthChecker()
	if err != nil {
		return err
	}
	return checker.Check(ctx)
}

func (s *ProcessService) healthChecker() (healthcheck.Checker, error) {
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

func (s *ProcessService) validate() error {
	if s.def.Validate == nil {
		return nil
	}
	issues := s.def.Validate(s.cfg)
	if len(issues) > 0 {
		return fmt.Errorf("%s: validation failed: %w", s.def.Type, errors.Join(issues...))
	}
	return nil
}

func (s *ProcessService) localInit(ctx context.Context) error {
	if s.def.LocalInit == nil {
		return nil
	}
	return s.def.LocalInit(ctx, s.cfg)
}

func (s *ProcessService) writeConfigFiles() error {
	if s.def.LocalConfigFiles == nil {
		return nil
	}
	files, err := s.def.LocalConfigFiles(s.cfg)
	if err != nil {
		return err
	}
	dataDir, err := s.dataDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return fmt.Errorf("create data dir %s: %w", dataDir, err)
	}
	for relPath, content := range files {
		path := filepath.Join(dataDir, relPath)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return fmt.Errorf("create config dir: %w", err)
		}
		if err := os.WriteFile(path, content, 0644); err != nil {
			return fmt.Errorf("write config file %s: %w", path, err)
		}
	}
	return nil
}

func (s *ProcessService) localCommand() (string, []string, []string, error) {
	binName := s.def.LocalBinary(s.cfg)
	bin, err := exec.LookPath(binName)
	if err != nil {
		return "", nil, nil, fmt.Errorf("%s binary %q not found on PATH: %w", s.def.Type, binName, err)
	}

	var args []string
	if s.def.LocalArgs != nil {
		args = s.def.LocalArgs(s.cfg)
	}

	var env []string
	if s.def.LocalEnv != nil {
		for k, v := range s.def.LocalEnv(s.cfg) {
			env = append(env, fmt.Sprintf("%s=%s", k, v))
		}
	}

	return bin, args, env, nil
}

func (s *ProcessService) dataDir() (string, error) {
	if s.def.DataDir == nil {
		return "", fmt.Errorf("%s: no data directory configured", s.def.Type)
	}
	return s.def.DataDir(s.cfg), nil
}

func (s *ProcessService) logDir() (string, error) {
	// Default log directory is the service data directory.
	return s.dataDir()
}

var _ serviceapi.Interface = (*ProcessService)(nil)
