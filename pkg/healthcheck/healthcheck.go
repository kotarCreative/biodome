// Package healthcheck provides pluggable health checks for services-runner.
// It supports TCP port checks, arbitrary command execution, HTTP GET probes,
// and service-specific shortcuts (e.g., pg_isready, redis-cli ping).
package healthcheck

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Config describes a health check as it appears in the service config.
type Config struct {
	Type    string   `yaml:"type,omitempty"`
	Command []string `yaml:"command,omitempty"`
	URL     string   `yaml:"url,omitempty"`
	Host    string   `yaml:"host,omitempty"`
	Port    int      `yaml:"port,omitempty"`
	Timeout string   `yaml:"timeout,omitempty"`
}

// Checker is the runtime health check interface.
type Checker interface {
	// Check returns nil when the service is healthy.
	Check(ctx context.Context) error
}

// CheckerFunc adapts a function to the Checker interface.
type CheckerFunc func(ctx context.Context) error

func (f CheckerFunc) Check(ctx context.Context) error { return f(ctx) }

// ParseTimeout parses the timeout string or returns the default.
func ParseTimeout(s string, defaultTimeout time.Duration) (time.Duration, error) {
	if s == "" {
		return defaultTimeout, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("invalid health check timeout %q: %w", s, err)
	}
	return d, nil
}

// FromConfig creates a Checker from a user-provided Config.
// If cfg is empty or type is empty, it returns nil, nil meaning no override.
func FromConfig(cfg Config) (Checker, error) {
	if cfg.Type == "" {
		return nil, nil
	}

	timeout, err := ParseTimeout(cfg.Timeout, 2*time.Second)
	if err != nil {
		return nil, err
	}

	switch cfg.Type {
	case "tcp":
		if cfg.Port == 0 {
			return nil, fmt.Errorf("tcp health check requires port")
		}
		return NewTCP(cfg.Host, cfg.Port, timeout), nil
	case "exec":
		if len(cfg.Command) == 0 {
			return nil, fmt.Errorf("exec health check requires command")
		}
		return NewExec(cfg.Command, timeout), nil
	case "http":
		if cfg.URL == "" {
			return nil, fmt.Errorf("http health check requires url")
		}
		return NewHTTP(cfg.URL, timeout), nil
	default:
		return nil, fmt.Errorf("unknown health check type %q", cfg.Type)
	}
}

// TCP checks that a TCP port is reachable.
type TCP struct {
	addr    string
	timeout time.Duration
}

// NewTCP creates a TCP health checker.
func NewTCP(host string, port int, timeout time.Duration) Checker {
	if host == "" {
		host = "localhost"
	}
	return &TCP{
		addr:    net.JoinHostPort(host, strconv.Itoa(port)),
		timeout: timeout,
	}
}

func (c *TCP) Check(ctx context.Context) error {
	dialer := &net.Dialer{Timeout: c.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		return fmt.Errorf("tcp health check %s: %w", c.addr, err)
	}
	conn.Close()
	return nil
}

// Exec runs a command and considers the service healthy if it exits 0.
type Exec struct {
	command []string
	timeout time.Duration
}

// NewExec creates an exec health checker.
func NewExec(command []string, timeout time.Duration) Checker {
	return &Exec{
		command: command,
		timeout: timeout,
	}
}

func (c *Exec) Check(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, c.command[0], c.command[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("exec health check %v: %w\n%s", c.command, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// HTTP performs an HTTP GET and expects a 2xx or 3xx status.
type HTTP struct {
	url     string
	timeout time.Duration
}

// NewHTTP creates an HTTP health checker.
func NewHTTP(url string, timeout time.Duration) Checker {
	return &HTTP{url: url, timeout: timeout}
}

func (c *HTTP) Check(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return fmt.Errorf("http health check %s: %w", c.url, err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("http health check %s: %w", c.url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return fmt.Errorf("http health check %s: unexpected status %d", c.url, resp.StatusCode)
	}
	return nil
}

// PostgresReady creates a pg_isready checker.
func PostgresReady(host string, port int, timeout time.Duration) Checker {
	if host == "" {
		host = "localhost"
	}
	return NewExec([]string{
		"pg_isready",
		"-h", host,
		"-p", strconv.Itoa(port),
	}, timeout)
}

// RedisPing creates a redis-cli ping checker.
func RedisPing(host string, port int, password string, timeout time.Duration) Checker {
	if host == "" {
		host = "localhost"
	}
	args := []string{
		"redis-cli",
		"-h", host,
		"-p", strconv.Itoa(port),
		"ping",
	}
	if password != "" {
		args = append([]string{"redis-cli", "-a", password, "--no-auth-warning"}, args[1:]...)
	}
	return NewExec(args, timeout)
}
